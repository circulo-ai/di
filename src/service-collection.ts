import { ServiceLifetime } from "./lifetime";
import type { ServiceDescriptor, ServiceFactory, ServiceKey, Token } from "./types";
import { ServiceProvider } from "./service-provider";

export class ServiceCollection {
  private readonly descriptors = new Map<Token, ServiceDescriptor[]>();

  addSingleton<T>(
    token: Token<T>,
    factoryOrInstance: ServiceFactory<T> | T,
    options?: { key?: ServiceKey; multiple?: boolean },
  ): this {
    const factory = this.wrapFactory(factoryOrInstance);
    return this.addDescriptor(token, {
      id: Symbol(),
      token,
      lifetime: ServiceLifetime.Singleton,
      factory,
      key: options?.key,
    }, options);
  }

  addScoped<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: { key?: ServiceKey; multiple?: boolean },
  ): this {
    return this.addDescriptor(
      token,
      { id: Symbol(), token, lifetime: ServiceLifetime.Scoped, factory, key: options?.key },
      options,
    );
  }

  addTransient<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: { key?: ServiceKey; multiple?: boolean },
  ): this {
    return this.addDescriptor(
      token,
      { id: Symbol(), token, lifetime: ServiceLifetime.Transient, factory, key: options?.key },
      options,
    );
  }

  build(): ServiceProvider {
    return new ServiceProvider(
      [...this.descriptors.entries()].flatMap(([_, descriptors]) => descriptors),
    );
  }

  private wrapFactory<T>(factoryOrInstance: ServiceFactory<T> | T): ServiceFactory<T> {
    if (typeof factoryOrInstance === "function") {
      return factoryOrInstance as ServiceFactory<T>;
    }
    return () => factoryOrInstance;
  }

  private addDescriptor<T>(
    token: Token<T>,
    descriptor: ServiceDescriptor<T>,
    options?: { multiple?: boolean },
  ): this {
    const existing = this.descriptors.get(token) ?? [];
    if (options?.multiple) {
      existing.push(descriptor);
      this.descriptors.set(token, existing);
    } else {
      this.descriptors.set(token, [descriptor]);
    }
    return this;
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get count(): number {
    let total = 0;
    for (const list of this.descriptors.values()) total += list.length;
    return total;
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get tokens(): Token[] {
    return [...this.descriptors.keys()];
  }
}
