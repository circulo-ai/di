import type { MiddlewareHandler, Context } from "hono";
import { ServiceProvider } from "./service-provider";
import type { ServiceScope } from "./service-scope";
import type { Token } from "./types";

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
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>
>(
  provider: ServiceProvider,
  options?: { variableName?: string }
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
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>
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
  TEnv extends WithContainer<TContainer> = ContainerEnv<TContainer>
>(
  c: Context<TEnv>,
  token: Token<T>,
  variableName = "container"
): T | undefined {
  const container = (c.var as Record<string, unknown>)[variableName] as
    | TContainer
    | undefined;
  if (!container) return undefined;
  return container.tryResolve(token);
}
