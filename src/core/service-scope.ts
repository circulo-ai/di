import { DisposedScopeError } from "./errors.js";
import { ServiceLifetime } from "./lifetime.js";
import {
  disposeFunctions,
  disposeMany,
  ServiceProvider,
} from "./service-provider.js";
import type {
  DisposeFn,
  ServiceDescriptor,
  ServiceKey,
  ServiceResolver,
  Token,
  TokenLike,
} from "./types.js";

export class ServiceScope implements ServiceResolver {
  private readonly scopedInstances = new Map<ServiceDescriptor, unknown>();
  private readonly scopedPromises = new Map<
    ServiceDescriptor,
    Promise<unknown>
  >();
  private readonly disposeHandlers: Array<{ fn: DisposeFn; priority: number }> =
    [];
  private readonly resolutionOrder: ServiceDescriptor[] = [];
  private disposed = false;

  constructor(private readonly root: ServiceProvider) {}

  /** .NET-style access to the resolver owned by this scope. */
  get serviceProvider(): ServiceResolver {
    return this;
  }

  onDispose(handler: DisposeFn): void {
    this.onDisposeWithPriority(handler);
  }

  onDisposeWithPriority(handler: DisposeFn, priority = 0): void {
    this.assertActive();
    this.disposeHandlers.push({ fn: handler, priority });
  }

  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T {
    this.assertActive();
    return this.root.resolveFromScope(token, this, key);
  }

  getRequiredService<T>(token: TokenLike<T>, key?: ServiceKey): T {
    return this.resolve(token, key);
  }

  getService<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
    const innerToken = typeof token === "object" ? token.token : token;
    if (!this.root.getDescriptor(innerToken, key)) return undefined;
    return this.resolve(token, key);
  }

  getServices<T>(token: Token<T>): T[] {
    return this.resolveAll(token);
  }

  async resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T> {
    this.assertActive();
    return await this.root.resolveFromScopeAsync(token, this, key);
  }

  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
    try {
      return this.resolve(token, key);
    } catch {
      return undefined;
    }
  }

  async tryResolveAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined> {
    this.assertActive();
    try {
      return await this.resolveAsync(token, key);
    } catch {
      return undefined;
    }
  }

  resolveAll<T>(token: Token<T>): T[] {
    this.assertActive();
    return this.root.resolveAllFromScope(token, this);
  }

  getOrCreate<T>(descriptor: ServiceDescriptor<T>): T {
    this.assertActive();
    if (descriptor.lifetime !== ServiceLifetime.Scoped) {
      throw new Error(
        `Descriptor for ${descriptor.token.toString()} is not scoped`,
      );
    }

    return this.root.resolveDescriptor(descriptor, this);
  }

  resolveMap<T>(token: Token<T>): Record<ServiceKey, T> {
    this.assertActive();
    return this.root.resolveMapFromScope(token, this);
  }

  hasCached(descriptor: ServiceDescriptor): boolean {
    return this.scopedInstances.has(descriptor);
  }

  getCached(descriptor: ServiceDescriptor): unknown | undefined {
    return this.scopedInstances.get(descriptor);
  }

  getPending(descriptor: ServiceDescriptor): Promise<unknown> | undefined {
    return this.scopedPromises.get(descriptor);
  }

  setPending(descriptor: ServiceDescriptor, promise: Promise<unknown>): void {
    this.scopedPromises.set(descriptor, promise);
  }

  clearPending(descriptor: ServiceDescriptor): void {
    this.scopedPromises.delete(descriptor);
  }

  setInstance(descriptor: ServiceDescriptor, value: unknown): void {
    this.scopedInstances.set(descriptor, value);
    this.scopedPromises.delete(descriptor);
    this.recordResolution(descriptor);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.scopedPromises.values()]);
    const handlers = [...this.disposeHandlers].sort(
      (a, b) => b.priority - a.priority,
    );
    const errors: unknown[] = [];
    await captureDisposalError(
      disposeFunctions(handlers.map((handler) => handler.fn)),
      errors,
    );
    const instances = this.resolutionOrder
      .map((d) => ({ descriptor: d, instance: this.scopedInstances.get(d) }))
      .filter((x) => x.instance !== undefined);
    await disposeMany(
      sortByPriorityAndOrder(
        instances.filter((item) => !item.descriptor.customDispose),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.instance as unknown),
    ).catch((error) => errors.push(error));
    await disposeFunctions(
      sortByPriorityAndOrder(
        this.resolutionOrder
          .map((d) => ({ descriptor: d, dispose: d.customDispose }))
          .filter((d) => d.dispose),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.dispose as DisposeFn),
    ).catch((error) => errors.push(error));
    this.scopedInstances.clear();
    this.scopedPromises.clear();
    this.resolutionOrder.length = 0;
    this.disposeHandlers.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple errors occurred during scope disposal.",
      );
    }
  }

  /** Familiar async-disposal alias for hosts that prefer explicit teardown. */
  async disposeAsync(): Promise<void> {
    await this.dispose();
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get activeCount(): number {
    return this.scopedInstances.size;
  }

  private recordResolution(descriptor: ServiceDescriptor): void {
    if (!this.resolutionOrder.includes(descriptor)) {
      this.resolutionOrder.push(descriptor);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new DisposedScopeError();
  }
}

async function captureDisposalError(
  operation: Promise<void>,
  errors: unknown[],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function sortByPriorityAndOrder<T>(
  items: Array<T>,
  prioritySelector: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const pa = prioritySelector(a);
    const pb = prioritySelector(b);
    if (pb !== pa) return pb - pa;
    return items.indexOf(b) - items.indexOf(a);
  });
}
/* c8 ignore stop */
