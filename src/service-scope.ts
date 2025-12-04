import { ServiceLifetime } from "./lifetime";
import type {
  ServiceDescriptor,
  ServiceKey,
  ServiceResolver,
  Token,
} from "./types";
import { disposeMany, ServiceProvider } from "./service-provider";

export class ServiceScope implements ServiceResolver {
  private readonly scopedInstances = new Map<ServiceDescriptor, unknown>();
  private disposed = false;

  constructor(private readonly root: ServiceProvider) {}

  resolve<T>(token: Token<T>, key?: ServiceKey): T {
    return this.root.resolveFromScope(token, this, key);
  }

  tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined {
    try {
      return this.resolve(token, key);
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
        `Descriptor for ${descriptor.token.toString()} is not scoped`
      );
    }

    if (this.scopedInstances.has(descriptor)) {
      return this.scopedInstances.get(descriptor) as T;
    }

    const instance = descriptor.factory(this);
    this.scopedInstances.set(descriptor, instance);
    return instance;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await disposeMany([...this.scopedInstances.values()]);
    this.scopedInstances.clear();
    this.disposed = true;
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get activeCount(): number {
    return this.scopedInstances.size;
  }
}
