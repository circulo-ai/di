import { DisposedScopeError, MissingServiceError } from "./errors.js";
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
  private readonly ownedInstances: Array<{
    descriptor: ServiceDescriptor;
    instance: unknown;
  }> = [];
  private disposed = false;

  constructor(private readonly root: ServiceProvider) {
    root.registerScope(this);
  }

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
    try {
      return this.resolve(token, key);
    } catch (error) {
      if (error instanceof MissingServiceError) return undefined;
      throw error;
    }
  }

  getServices<T>(token: Token<T>): T[] {
    return this.resolveAll(token);
  }

  getServicesAsync<T>(token: Token<T>): Promise<T[]> {
    return this.resolveAllAsync(token);
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

  tryResolveMissing<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
    return this.root.resolveFromScopeMissing(token, this, key);
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

  async tryResolveMissingAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined> {
    this.assertActive();
    return await this.root.resolveFromScopeMissingAsync(token, this, key);
  }

  resolveAll<T>(token: Token<T>): T[] {
    this.assertActive();
    return this.root.resolveAllFromScope(token, this);
  }

  async resolveAllAsync<T>(token: Token<T>): Promise<T[]> {
    this.assertActive();
    return this.root.resolveAllFromScopeAsync(token, this);
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

  async resolveMapAsync<T>(token: Token<T>): Promise<Record<ServiceKey, T>> {
    this.assertActive();
    return this.root.resolveMapFromScopeAsync(token, this);
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

  /** @internal Called by ServiceProvider for explicitly scope-owned transients. */
  trackOwnedInstance(descriptor: ServiceDescriptor, instance: unknown): void {
    this.ownedInstances.push({ descriptor, instance });
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
        instances.filter(
          (item) =>
            effectiveDisposal(item.descriptor) === "scope" &&
            !item.descriptor.customDispose,
        ),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.instance as unknown),
    ).catch((error) => errors.push(error));
    await disposeFunctions(
      sortByPriorityAndOrder(
        this.resolutionOrder
          .map((d) => ({ descriptor: d, dispose: d.customDispose }))
          .filter(
            (d) => d.dispose && effectiveDisposal(d.descriptor) === "scope",
          ),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.dispose as DisposeFn),
    ).catch((error) => errors.push(error));
    await disposeOwnedInstances(this.ownedInstances, errors);
    this.scopedInstances.clear();
    this.scopedPromises.clear();
    this.ownedInstances.length = 0;
    this.resolutionOrder.length = 0;
    this.disposeHandlers.length = 0;
    this.root.unregisterScope(this);
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

  /** @internal Allows an in-flight factory to finish while the scope drains. */
  assertResolutionActive(owner?: ServiceDescriptor): void {
    if (!this.disposed) return;
    if (owner && this.scopedPromises.has(owner)) return;
    throw new DisposedScopeError();
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

async function disposeOwnedInstances(
  instances: Array<{ descriptor: ServiceDescriptor; instance: unknown }>,
  errors: unknown[],
): Promise<void> {
  const ordered = sortByPriorityAndOrder(
    instances,
    (item) => item.descriptor.disposePriority,
  );
  try {
    await disposeMany(
      ordered
        .filter((item) => !item.descriptor.customDispose)
        .map((item) => item.instance),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeFunctions(
      ordered
        .filter((item) => item.descriptor.customDispose)
        .map((item) => item.descriptor.customDispose as DisposeFn),
    );
  } catch (error) {
    errors.push(error);
  }
}

function effectiveDisposal(descriptor: ServiceDescriptor): string {
  if (descriptor.disposal) return descriptor.disposal;
  return descriptor.lifetime === ServiceLifetime.Scoped ? "scope" : "none";
}
/* c8 ignore stop */
