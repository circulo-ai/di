import type { Context, MiddlewareHandler } from "hono";
import type { Env, Input } from "hono/types";
import { ServiceProvider } from "../core/service-provider";
import type { ServiceScope } from "../core/service-scope";
import type { Token } from "../core/types";
import type { ResolvedServices, TokenTree } from "../helpers/locator";
import { createServiceLocator } from "../helpers/locator";

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

export type ServicesFromTokens<TTokens extends TokenTree> =
  ResolvedServices<TTokens>;

export type ContextWithServices<
  TTokens extends TokenTree,
  TEnv extends Env = Env,
  P extends string = string,
  I extends Input = {},
> = Context<TEnv, P, I> & { di: ServicesFromTokens<TTokens> };

export function createContextDiProxy<
  TTokens extends TokenTree,
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
      const proxy = createServiceLocator(container, tokens, { cache, strict });
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

export function bindToHono<
  TTokens extends TokenTree,
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
  const cache = options?.memoize ?? options?.cache ?? false;
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
