import type { ServiceProvider } from "../core/service-provider";
import type { ServiceScope } from "../core/service-scope";

const DEFAULT_PROVIDER_KEY = Symbol.for("@circulo-ai/di:next:provider");

/**
 * Reuse a provider across hot reloads (e.g., in Next.js) by storing it on
 * `globalThis`. The factory is only invoked when no provider exists for the
 * given key.
 */
export function getGlobalProvider<TProvider extends ServiceProvider>(
  factory: () => TProvider,
  key: string | symbol = DEFAULT_PROVIDER_KEY,
): TProvider {
  const store = globalThis as Record<string | symbol, unknown>;
  const existing = store[key] as TProvider | undefined;
  if (existing) return existing;
  const created = factory();
  store[key] = created;
  return created;
}

/**
 * Wrap a handler so each invocation gets its own scoped container that
 * disposes automatically. Useful for Next.js route handlers and API routes.
 */
export function withRequestScope<
  TScope extends ServiceScope = ServiceScope,
  TRequest = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
>(
  provider: ServiceProvider,
  handler: (
    request: TRequest,
    context: TContext & { container: TScope },
  ) => Promise<TResult> | TResult,
  options?: { containerProp?: string },
): (request: TRequest, context: TContext) => Promise<TResult> {
  const containerProp = options?.containerProp ?? "container";
  return async (request: TRequest, context: TContext) => {
    const scope = provider.createScope() as TScope;
    const ctxWithContainer = {
      ...(context as Record<string, unknown>),
      [containerProp]: scope,
    } as TContext & { container: TScope };

    try {
      return await handler(request, ctxWithContainer);
    } finally {
      await scope.dispose();
    }
  };
}
