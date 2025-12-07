import type { MiddlewareHandler, Context } from "hono";
import { ServiceProvider } from "./service-provider";
import type { ServiceScope } from "./service-scope";
import type { Token } from "./types";
import type { Env, Input } from "hono/types";

export type ContainerEnv<TContainer extends ServiceScope = ServiceScope> = {
  Variables: {
    container: TContainer;
  };
};

type WithContainer<TContainer extends ServiceScope> = {
  Variables: ContainerEnv<TContainer>["Variables"] & Record<string, unknown>;
};

export function createContainerMiddleware<
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(
  provider: ServiceProvider,
  options?: { variableName?: string },
): MiddlewareHandler<TEnv> {
  const variableName = options?.variableName ?? "container";
  return async (c, next) => {
    const scope = provider.createScope() as TContainer;
    c.set(variableName as "container", scope);
    try {
      await next();
    } finally {
      await scope.dispose();
    }
  };
}

export function resolveFromContext<
  T,
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(c: Context<TEnv>, token: Token<T>, variableName = "container"): T {
  const container = (c.var as Record<string, unknown>)[variableName] as
    | TContainer
    | undefined;
  if (!container) {
    throw new Error("DI container is missing on the request context.");
  }
  return container.resolve(token);
}

export function tryResolveFromContext<
  T,
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(
  c: Context<TEnv>,
  token: Token<T>,
  variableName = "container",
): T | undefined {
  const container = (c.var as Record<string, unknown>)[variableName] as
    | TContainer
    | undefined;
  if (!container) return undefined;
  return container.tryResolve(token);
}

export type ServicesFromTokens<TTokens extends Record<string, Token>> = {
  [K in keyof TTokens]: TTokens[K] extends Token<infer T> ? T : unknown;
};

export type ContextWithServices<
  TTokens extends Record<string, Token>,
  TEnv extends Env = Env,
  P extends string = string,
  I extends Input = {},
> = Context<TEnv, P, I> & { di: ServicesFromTokens<TTokens> };

export function createContextDiProxy<
  TTokens extends Record<string, Token>,
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(
  tokens: TTokens,
  options?: {
    /**
     * Name of the variable on Hono context that stores the DI container.
     * Defaults to "container".
     */
    variableName?: string;
    /**
     * Property name to expose on the Hono context. Defaults to "di".
     */
    propertyName?: string;
    /**
     * Cache resolved services for the lifetime of the request. Defaults to false
     * to preserve transient service semantics.
     */
    cache?: boolean;
    /**
     * Alias for cache; kept for clarity.
     */
    memoize?: boolean;
    /**
     * Throw if a token is missing instead of returning undefined.
     */
    strict?: boolean;
  },
): MiddlewareHandler<TEnv> {
  const variableName = options?.variableName ?? "container";
  const propertyName = options?.propertyName ?? "di";
  const cache = options?.memoize ?? options?.cache ?? false;
  const strict = options?.strict ?? false;

  return async (c, next) => {
    const container = (c.var as Record<string, unknown>)[variableName] as
      | TContainer
      | undefined;
    if (!container) {
      throw new Error("DI container is missing on the request context.");
    }

    const current = (c as unknown as Record<string, unknown>)[propertyName];
    if (!current) {
      const proxy = createServiceProxy(container, tokens, cache, strict);
      Object.defineProperty(c, propertyName, {
        value: proxy,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }

    await next();
  };
}

function createServiceProxy<
  TTokens extends Record<string, Token>,
  TContainer extends ServiceScope = ServiceScope,
>(
  container: TContainer,
  tokens: TTokens,
  cache: boolean,
  strict: boolean,
): ServicesFromTokens<TTokens> {
  const resolved = cache ? new Map<keyof TTokens, unknown>() : null;

  return new Proxy({} as ServicesFromTokens<TTokens>, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      if (!Object.prototype.hasOwnProperty.call(tokens, prop)) return undefined;

      const key = prop as keyof TTokens;
      if (resolved?.has(key)) {
        return resolved.get(key) as ServicesFromTokens<TTokens>[typeof key];
      }

      const token = tokens[key];
      if (!token) {
        throw new Error(`Service token not registered for "${prop}".`);
      }

      const value = container.resolve(
        token as Token<ServicesFromTokens<TTokens>[typeof key]>,
      );
      if (resolved) {
        resolved.set(key, value);
      }

      return value as ServicesFromTokens<TTokens>[typeof key];
    },
  });
}

export function bindToHono<
  TTokens extends Record<string, Token>,
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(
  app: { use: (path: string, mw: MiddlewareHandler<TEnv>) => void },
  provider: ServiceProvider,
  tokens: TTokens,
  options?: {
    var?: string;
    prop?: string;
    cache?: boolean;
    memoize?: boolean;
    strict?: boolean;
  },
): void {
  const variableName = options?.var ?? "container";
  const propertyName = options?.prop ?? "di";
  const cache = options?.memoize ?? options?.cache ?? true;
  const strict = options?.strict ?? false;

  app.use("*", createContainerMiddleware(provider, { variableName }));
  app.use(
    "*",
    createContextDiProxy(tokens, {
      variableName,
      propertyName,
      cache,
      strict,
    }),
  );
}

export function decorateContext<
  TTokens extends Record<string, Token>,
  TContainer extends ServiceScope = ServiceScope,
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>,
>(
  tokens: TTokens,
  options?: { variableName?: string; targetVar?: string },
): MiddlewareHandler<TEnv> {
  const variableName = options?.variableName ?? "container";
  const targetVar = options?.targetVar ?? "services";
  return async (c, next) => {
    const container = (c.var as Record<string, unknown>)[variableName] as
      | TContainer
      | undefined;
    if (!container) {
      throw new Error("DI container is missing on the request context.");
    }
    const resolved: Record<string, unknown> = {};
    for (const [name, token] of Object.entries(tokens)) {
      resolved[name] = await container.resolveAsync(token as Token<unknown>);
    }
    c.set(targetVar as any, resolved as any);
    await next();
  };
}
