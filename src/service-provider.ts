import { ServiceLifetime } from "./lifetime";
import type { MaybeDisposable, ServiceDescriptor, ServiceResolver, Token } from "./types";
import { ServiceScope } from "./service-scope";

export class ServiceProvider implements ServiceResolver {
  private readonly descriptors: Map<Token, ServiceDescriptor>;
  private readonly singletons = new Map<Token, unknown>();

  constructor(descriptors: ServiceDescriptor[]) {
    this.descriptors = new Map(descriptors.map((descriptor) => [descriptor.token, descriptor]));
  }

  resolve<T>(token: Token<T>): T {
    return this.resolveInternal(token, null);
  }

  tryResolve<T>(token: Token<T>): T | undefined {
    const descriptor = this.descriptors.get(token) as ServiceDescriptor<T> | undefined;
    if (!descriptor) return undefined;
    try {
      return this.resolveInternal(token, null);
    } catch {
      return undefined;
    }
  }

  createScope(): ServiceScope {
    return new ServiceScope(this);
  }

  async dispose(): Promise<void> {
    await disposeMany([...this.singletons.values()]);
    this.singletons.clear();
  }

  getDescriptor(token: Token): ServiceDescriptor | undefined {
    return this.descriptors.get(token);
  }

  has(token: Token): boolean {
    return this.descriptors.has(token);
  }

  resolveFromScope<T>(token: Token<T>, scope: ServiceScope): T {
    return this.resolveInternal(token, scope);
  }

  private resolveInternal<T>(token: Token<T>, scope: ServiceScope | null): T {
    const descriptor = this.descriptors.get(token) as ServiceDescriptor<T> | undefined;
    if (!descriptor) {
      throw new Error(`Service not registered: ${token.toString()}`);
    }

    if (descriptor.lifetime === ServiceLifetime.Singleton) {
      if (this.singletons.has(token)) {
        return this.singletons.get(token) as T;
      }
      const instance = descriptor.factory(this) as T;
      this.singletons.set(token, instance);
      return instance;
    }

    if (descriptor.lifetime === ServiceLifetime.Scoped) {
      if (!scope) {
        throw new Error(
          `Cannot resolve scoped service "${token.toString()}" from root provider. Create a scope first.`,
        );
      }
      return scope.getOrCreate(token, descriptor);
    }

    return descriptor.factory(scope ?? this) as T;
  }
}

export async function disposeMany(services: unknown[]): Promise<void> {
  const disposals: Promise<void>[] = [];
  for (const service of services) {
    const disposeFn = getDisposeFn(service);
    if (typeof disposeFn === "function") {
      const result = disposeFn.call(service);
      if (result instanceof Promise) {
        disposals.push(result.then(() => undefined));
      }
    }
  }
  if (disposals.length) {
    await Promise.all(disposals);
  }
}

function getDisposeFn(service: unknown): (() => void | Promise<void>) | undefined {
  if (!service || (typeof service !== "object" && typeof service !== "function")) {
    return undefined;
  }
  const candidate = service as MaybeDisposable & Record<string, unknown>;
  if (typeof candidate.dispose === "function") return candidate.dispose.bind(service);
  if (typeof candidate.close === "function") return candidate.close.bind(service);
  if (typeof candidate.destroy === "function") return candidate.destroy.bind(service);
  return undefined;
}
