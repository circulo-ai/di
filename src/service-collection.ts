import { ServiceLifetime } from "./lifetime";
import type { ServiceDescriptor, ServiceFactory, Token } from "./types";
import { ServiceProvider } from "./service-provider";

export class ServiceCollection {
  private readonly descriptors = new Map<Token, ServiceDescriptor>();

  addSingleton<T>(token: Token<T>, factoryOrInstance: ServiceFactory<T> | T): this {
    const factory = this.wrapFactory(factoryOrInstance);
    this.descriptors.set(token, { token, lifetime: ServiceLifetime.Singleton, factory });
    return this;
  }

  addScoped<T>(token: Token<T>, factory: ServiceFactory<T>): this {
    this.descriptors.set(token, { token, lifetime: ServiceLifetime.Scoped, factory });
    return this;
  }

  addTransient<T>(token: Token<T>, factory: ServiceFactory<T>): this {
    this.descriptors.set(token, { token, lifetime: ServiceLifetime.Transient, factory });
    return this;
  }

  build(): ServiceProvider {
    return new ServiceProvider([...this.descriptors.values()]);
  }

  private wrapFactory<T>(factoryOrInstance: ServiceFactory<T> | T): ServiceFactory<T> {
    if (typeof factoryOrInstance === "function") {
      return factoryOrInstance as ServiceFactory<T>;
    }
    return () => factoryOrInstance;
  }
}
