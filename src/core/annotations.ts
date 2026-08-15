import type {
  DependencyArray,
  DependencyObject,
  ServiceFactory,
  ServiceResolver,
  TokenLike,
} from "./types.js";

export type InjectionDependencies = DependencyArray | DependencyObject;

type Constructor = abstract new (...args: any[]) => unknown;

const INJECTION_METADATA = Symbol.for("@circulo-ai/di:injection-metadata");

/**
 * Attach constructor dependency metadata without requiring reflect-metadata.
 * This can be used directly or through the `injectable()` decorator.
 */
export function annotate<TClass extends Constructor>(
  target: TClass,
  dependencies: InjectionDependencies,
): TClass {
  const metadata = normalizeDependencies(dependencies);
  Object.defineProperty(target, INJECTION_METADATA, {
    value: metadata,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return target;
}

/**
 * Opt-in class decorator for constructor injection.
 *
 * @example
 * `@injectable([LOGGER]) class Service { constructor(logger: Logger) {} }`
 */
export function injectable(dependencies: InjectionDependencies) {
  return <TClass extends Constructor>(target: TClass): TClass =>
    annotate(target, dependencies);
}

/** Return the dependencies explicitly annotated on a class, if any. */
export function getInjectionMetadata(
  target: Constructor,
): InjectionDependencies | undefined {
  if (!Object.prototype.hasOwnProperty.call(target, INJECTION_METADATA)) {
    return undefined;
  }
  return (target as unknown as Record<symbol, InjectionDependencies>)[
    INJECTION_METADATA
  ];
}

/** Create a synchronous class factory from explicit annotation metadata. */
export function annotatedClassFactory<T>(
  target: new (...args: any[]) => T,
): ServiceFactory<T> {
  const dependencies = getInjectionMetadata(target);
  if (!dependencies && target.length > 0) {
    throw new TypeError(
      `Class ${target.name || "anonymous"} declares constructor parameters but has no injection metadata. Add @injectable([...]) or call annotate(Class, [...]).`,
    );
  }
  return (resolver) => {
    const resolved = resolveDependencies(resolver, dependencies);
    if (resolved === undefined) return new target();
    if (Array.isArray(resolved)) return new target(...resolved);
    return new target(resolved);
  };
}

function normalizeDependencies(
  dependencies: InjectionDependencies,
): InjectionDependencies {
  if (Array.isArray(dependencies)) {
    dependencies.forEach(assertTokenLike);
    return Object.freeze([...dependencies]);
  }

  const copy = Object.create(null) as Record<string, TokenLike>;
  for (const [name, token] of Object.entries(dependencies)) {
    assertTokenLike(token);
    Object.defineProperty(copy, name, {
      value: token,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function assertTokenLike(token: TokenLike): void {
  if (
    typeof token === "string" ||
    typeof token === "symbol" ||
    typeof token === "function"
  ) {
    return;
  }
  if (
    token &&
    typeof token === "object" &&
    token.__optional === true &&
    (typeof token.token === "string" ||
      typeof token.token === "symbol" ||
      typeof token.token === "function")
  ) {
    return;
  }
  throw new TypeError("Injection metadata contains an invalid service token.");
}

function resolveDependencies(
  resolver: ServiceResolver,
  dependencies: InjectionDependencies | undefined,
): unknown {
  if (!dependencies) return undefined;
  if (Array.isArray(dependencies)) {
    return dependencies.map((token) => resolver.getRequiredService(token));
  }
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, token]) => [
      name,
      resolver.getRequiredService(token),
    ]),
  );
}
