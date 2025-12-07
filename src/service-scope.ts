import { ServiceLifetime } from "./lifetime";
import type {
  ServiceDescriptor,
  DisposeFn,
  ServiceKey,
  ServiceResolver,
  Token,
  TokenLike,
} from "./types";
import { disposeMany, ServiceProvider } from "./service-provider";
import { AsyncFactoryError } from "./errors";

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

  onDispose(handler: DisposeFn): void {
    this.onDisposeWithPriority(handler);
  }

  onDisposeWithPriority(handler: DisposeFn, priority = 0): void {
    this.disposeHandlers.push({ fn: handler, priority });
  }

  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T {
    return this.root.resolveFromScope(token, this, key);
  }

  async resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T> {
    return await this.root.resolveFromScopeAsync(token, this, key);
  }

  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
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
    try {
      return await this.resolveAsync(token, key);
    } catch {
      return undefined;
    }
  }

  resolveAll<T>(token: Token<T>): T[] {
    const descriptors = this.root.getDescriptors(token);
    if (!descriptors?.length) return [];
    return descriptors.map((d) => this.root.resolveDescriptor(d, this));
  }

  getOrCreate<T>(descriptor: ServiceDescriptor<T>): T {
    if (descriptor.lifetime !== ServiceLifetime.Scoped) {
      throw new Error(
        `Descriptor for ${descriptor.token.toString()} is not scoped`,
      );
    }

    if (this.scopedInstances.has(descriptor)) {
      return this.scopedInstances.get(descriptor) as T;
    }

    const instance = descriptor.factory(this);
    if (instance && typeof (instance as any).then === "function") {
      throw new AsyncFactoryError(
        `Async factory detected for ${descriptor.token.toString()}. Use resolveAsync().`,
      );
    }
    this.scopedInstances.set(descriptor, instance as T);
    this.recordResolution(descriptor);
    return instance as T;
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

  setInstance(descriptor: ServiceDescriptor, value: unknown): void {
    this.scopedInstances.set(descriptor, value);
    this.scopedPromises.delete(descriptor);
    this.recordResolution(descriptor);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const handlers = [...this.disposeHandlers].sort(
      (a, b) => b.priority - a.priority,
    );
    for (const handler of handlers) {
      await handler.fn();
    }
    const instances = this.resolutionOrder
      .map((d) => ({ descriptor: d, instance: this.scopedInstances.get(d) }))
      .filter((x) => x.instance !== undefined);
    await disposeMany(
      sortByPriorityAndOrder(
        instances,
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.instance as unknown),
    );
    await disposeMany(
      sortByPriorityAndOrder(
        this.resolutionOrder
          .map((d) => ({ descriptor: d, dispose: d.customDispose }))
          .filter((d) => d.dispose),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.dispose as DisposeFn),
    );
    this.scopedInstances.clear();
    this.scopedPromises.clear();
    this.resolutionOrder.length = 0;
    this.disposed = true;
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
