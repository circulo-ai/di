import type {
  DependencyArray,
  DependencyObject,
  ServiceFactory,
  ServiceResolver,
  TokenLike,
  Transform,
} from "./types.js";

export type InjectionDependencies = DependencyArray | DependencyObject;
export type InjectionParameter = {
  token: TokenLike;
  multiple?: boolean;
  optional?: boolean;
  transform?:
    | TokenLike
    | Transform<unknown, unknown>
    | ((input: any, ...args: any[]) => unknown);
  transformArgs?: readonly unknown[];
};

type Constructor = abstract new (...args: any[]) => unknown;
type InjectableMetadata = {
  dependencies?: InjectionDependencies;
  parameters?: InjectionParameter[];
};

const INJECTION_METADATA = Symbol.for("@circulo-ai/di:injection-metadata");
const PARAMETER_METADATA = Symbol.for("@circulo-ai/di:parameter-metadata");

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
    value: { dependencies: metadata } satisfies InjectableMetadata,
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
export function injectable(dependencies?: InjectionDependencies) {
  return <TClass extends Constructor>(target: TClass): TClass => {
    if (dependencies === undefined) {
      defineMetadata(target, { parameters: getParameterMetadata(target) });
      return target;
    }
    return annotate(target, dependencies);
  };
}

/**
 * Store a token for one constructor parameter. This is a legacy-compatible
 * parameter decorator and does not require `reflect-metadata`.
 */
export function inject(
  token: TokenLike,
  options?: { isOptional?: boolean },
): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    defineParameterMetadata(target as Constructor, parameterIndex, {
      token,
      optional: options?.isOptional,
    });
  };
}

/** Inject every registration for a token into an array parameter. */
export function injectAll(
  token: TokenLike,
  options?: { isOptional?: boolean },
): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    defineParameterMetadata(target as Constructor, parameterIndex, {
      token,
      multiple: true,
      optional: options?.isOptional,
    });
  };
}

/** Resolve and transform one service before passing it to the constructor. */
export function injectWithTransform(
  token: TokenLike,
  transform:
    | TokenLike
    | Transform<unknown, unknown>
    | ((input: any, ...args: any[]) => unknown),
  ...transformArgs: unknown[]
): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    defineParameterMetadata(target as Constructor, parameterIndex, {
      token,
      transform,
      transformArgs,
    });
  };
}

/** Resolve all services and transform the resulting array. */
export function injectAllWithTransform(
  token: TokenLike,
  transform:
    | TokenLike
    | Transform<unknown[], unknown>
    | ((input: any, ...args: any[]) => unknown),
  ...transformArgs: unknown[]
): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    defineParameterMetadata(target as Constructor, parameterIndex, {
      token,
      multiple: true,
      transform,
      transformArgs,
    });
  };
}

/** Return the dependencies explicitly annotated on a class, if any. */
export function getInjectionMetadata(
  target: Constructor,
): InjectionDependencies | undefined {
  return getMetadata(target)?.dependencies;
}

/** Return parameter-decorator metadata for a class. */
export function getInjectionParameters(
  target: Constructor,
): InjectionParameter[] | undefined {
  const metadata = getMetadata(target);
  if (metadata?.parameters?.length) return metadata.parameters;

  const reflected = getDesignParamTypes(target);
  return reflected?.length ? reflected.map((token) => ({ token })) : undefined;
}

/** Create a synchronous class factory from explicit annotation metadata. */
export function annotatedClassFactory<T>(
  target: new (...args: any[]) => T,
): ServiceFactory<T> {
  const dependencies = getInjectionMetadata(target);
  const parameters = getInjectionParameters(target);
  if (!dependencies && !parameters && target.length > 0) {
    throw new TypeError(
      `Class ${target.name || "anonymous"} declares constructor parameters but has no injection metadata. Add @injectable([...]) or call annotate(Class, [...]).`,
    );
  }
  return (resolver) => {
    const resolved = parameters
      ? resolveParameters(resolver, parameters)
      : resolveDependencies(resolver, dependencies);
    if (resolved === undefined) return new target();
    if (Array.isArray(resolved)) return new target(...resolved);
    return new target(resolved);
  };
}

/** @internal Resolve constructor parameter metadata for decorator adapters. */
export function resolveInjectionParameters(
  resolver: ServiceResolver,
  target: Constructor,
): unknown[] {
  const parameters = getInjectionParameters(target);
  if (!parameters) return [];
  return resolveParameters(resolver, parameters);
}

function defineMetadata(
  target: Constructor,
  metadata: InjectableMetadata,
): void {
  const existing = getMetadata(target) ?? {};
  Object.defineProperty(target, INJECTION_METADATA, {
    value: { ...existing, ...metadata },
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

function defineParameterMetadata(
  target: Constructor,
  index: number,
  parameter: InjectionParameter,
): void {
  const parameters = getParameterMetadata(target) ?? [];
  parameters[index] = parameter;
  Object.defineProperty(target, PARAMETER_METADATA, {
    value: parameters,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

function getMetadata(target: Constructor): InjectableMetadata | undefined {
  return (target as unknown as Record<symbol, InjectableMetadata>)[
    INJECTION_METADATA
  ];
}

function getParameterMetadata(
  target: Constructor,
): InjectionParameter[] | undefined {
  const parameters = (
    target as unknown as Record<symbol, InjectionParameter[]>
  )[PARAMETER_METADATA];
  return parameters ? [...parameters] : undefined;
}

function getDesignParamTypes(target: Constructor): TokenLike[] | undefined {
  const reflected = (
    Reflect as typeof Reflect & {
      getMetadata?: (key: string, value: unknown) => unknown;
    }
  ).getMetadata?.("design:paramtypes", target);
  return Array.isArray(reflected) ? (reflected as TokenLike[]) : undefined;
}

function resolveParameters(
  resolver: ServiceResolver,
  parameters: InjectionParameter[],
): unknown[] {
  return parameters.map((parameter) => {
    const token = parameter.optional
      ? ({ __optional: true, token: parameter.token } as TokenLike)
      : parameter.token;
    const value = parameter.multiple
      ? resolveAllParameters(resolver, token, parameter.optional)
      : resolver.resolve(token);
    if (!parameter.transform) return value;

    const directFunctionTransform =
      typeof parameter.transform === "function" &&
      typeof (parameter.transform as { prototype?: { transform?: unknown } })
        .prototype?.transform !== "function";
    const transformer = directFunctionTransform
      ? parameter.transform
      : resolveTransformer(
          resolver,
          parameter.transform as TokenLike | Transform<unknown, unknown>,
        );
    if (typeof transformer === "function") {
      return transformer(value, ...(parameter.transformArgs ?? []));
    }
    if (
      !transformer ||
      typeof (transformer as Transform<unknown, unknown>).transform !==
        "function"
    ) {
      throw new TypeError(
        "Injection transform must expose a transform method.",
      );
    }
    return (transformer as Transform<unknown, unknown>).transform(
      value,
      ...(parameter.transformArgs ?? []),
    );
  });
}

function resolveAllParameters(
  resolver: ServiceResolver,
  token: TokenLike,
  optional = false,
): unknown[] {
  const { token: inner } = unwrapOptional(token);
  const registered =
    (
      resolver as ServiceResolver & {
        isRegistered?: (token: TokenLike, recursive?: boolean) => boolean;
        has?: (token: TokenLike) => boolean;
      }
    ).isRegistered?.(inner, true) ??
    (
      resolver as ServiceResolver & { has?: (token: TokenLike) => boolean }
    ).has?.(inner);
  if (!registered && !optional) {
    throw new Error(`No registrations found for ${String(inner)}.`);
  }
  return resolver.resolveAll(inner as never);
}

function resolveTransformer(
  resolver: ServiceResolver,
  transform: TokenLike | Transform<unknown, unknown>,
): unknown {
  if (
    typeof transform === "function" ||
    typeof transform === "string" ||
    typeof transform === "symbol"
  ) {
    return resolver.resolve(transform);
  }
  return transform;
}

function unwrapOptional(token: TokenLike): { token: TokenLike } {
  if (token && typeof token === "object") {
    const candidate = token as { __optional?: unknown; token?: TokenLike };
    if (candidate.__optional === true && candidate.token !== undefined) {
      return { token: candidate.token };
    }
  }
  return { token };
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
  if (isRuntimeTokenLike(token)) {
    return;
  }
  const candidate = token as unknown as {
    __optional?: unknown;
    token?: unknown;
  };
  if (
    token &&
    typeof token === "object" &&
    candidate.__optional === true &&
    isRuntimeTokenLike(candidate.token)
  ) {
    return;
  }
  throw new TypeError("Injection metadata contains an invalid service token.");
}

function isRuntimeTokenLike(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "symbol" ||
    typeof value === "function" ||
    isDelayedToken(value)
  );
}

function isDelayedToken(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { __delayed?: unknown }).__delayed === true,
  );
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
