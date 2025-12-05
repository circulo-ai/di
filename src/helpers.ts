import type { ServiceCollection } from "./service-collection";
import type { ServiceResolver, Token, TokenLike } from "./types";
import { ServiceLifetime } from "./lifetime";

export function factory<T>(token: TokenLike<T>) {
  return (resolver: ServiceResolver) => () => resolver.resolve(token);
}

export function lazy<T>(token: TokenLike<T>) {
  return (resolver: ServiceResolver) => {
    let cached: T | undefined;
    let initialized = false;
    return () => {
      if (!initialized) {
        cached = resolver.resolve(token);
        initialized = true;
      }
      return cached as T;
    };
  };
}

export function useExisting<T>(
  services: ServiceCollection,
  token: Token<T>,
  existing: TokenLike<T>,
  options?: { lifetime?: ServiceLifetime; key?: string | number | symbol },
): ServiceCollection {
  const lifetime = options?.lifetime ?? ServiceLifetime.Singleton;
  const register = makeRegister(services, lifetime);
  return register(token, (r: ServiceResolver) => r.resolve(existing), {
    key: options?.key,
    multiple: true,
  });
}

export function useClass<T>(
  services: ServiceCollection,
  token: Token<T>,
  Klass: new () => T,
  options?: { lifetime?: ServiceLifetime; key?: string | number | symbol },
): ServiceCollection {
  const lifetime = options?.lifetime ?? ServiceLifetime.Transient;
  const register = makeRegister(services, lifetime);
  return register(token, () => new Klass(), {
    key: options?.key,
    multiple: true,
  });
}

function makeRegister(
  services: ServiceCollection,
  lifetime: ServiceLifetime,
): (
  token: Token<any>,
  factory: any,
  options?: { key?: string | number | symbol; multiple?: boolean },
) => ServiceCollection {
  switch (lifetime) {
    case ServiceLifetime.Singleton:
      return services.addSingleton.bind(services);
    case ServiceLifetime.GlobalSingleton:
      return services.addGlobalSingleton.bind(services);
    case ServiceLifetime.Scoped:
      return services.addScoped.bind(services);
    case ServiceLifetime.Transient:
    default:
      return services.addTransient.bind(services);
  }
}
