import { ServiceLifetime } from "./lifetime";
import type { ServiceDescriptor, ServiceResolver, Token } from "./types";
import { disposeMany, ServiceProvider } from "./service-provider";

export class ServiceScope implements ServiceResolver {
  private readonly scopedInstances = new Map<Token, unknown>();
  private disposed = false;

  constructor(private readonly root: ServiceProvider) {}

  resolve<T>(token: Token<T>): T {
    return this.root.resolveFromScope(token, this);
  }

  tryResolve<T>(token: Token<T>): T | undefined {
    try {
      return this.resolve(token);
    } catch {
      return undefined;
    }
  }

  getOrCreate<T>(token: Token<T>, descriptor: ServiceDescriptor<T>): T {
    if (descriptor.lifetime !== ServiceLifetime.Scoped) {
      throw new Error(`Descriptor for ${token.toString()} is not scoped`);
    }

    if (this.scopedInstances.has(token)) {
      return this.scopedInstances.get(token) as T;
    }

    const instance = descriptor.factory(this);
    this.scopedInstances.set(token, instance);
    return instance;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await disposeMany([...this.scopedInstances.values()]);
    this.scopedInstances.clear();
    this.disposed = true;
  }
}
