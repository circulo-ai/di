# DI Package Guide

## Core APIs

- `ServiceCollection`: register services with `addSingleton`, `addGlobalSingleton`, `addScoped`, `addTransient`, `useExisting`, `useClass`; defaults for `allowOverwrite` / `defaultMultiple`; capture metadata (registeredAt/source).
- `ServiceProvider`: resolves sync/async factories, caches singletons/global singletons, creates scopes, tracing hook, `withScope`, structured errors with paths.
- `ServiceScope`: per-request/per-operation resolver that caches scoped instances and disposes them in reverse resolution order with priorities.
- `ServiceLifetime`: enum of `Singleton`, `GlobalSingleton`, `Scoped`, `Transient`.
- `Token<T>`: string | symbol | class constructor; `createToken<T>()` helper recommended; `optional(token)` for optional resolution.
- `resolve`, `resolveAsync`, `tryResolve`, `tryResolveAsync`, `resolveAll`, `resolveMap`.
- `has`: check if a token is registered.
- `key`/`multiple`: register multiple implementations and pick by key.
- Helpers: `factory`/`lazy`, `ifProd`/`ifDev`/`ifTruthy`, `bindToHono`, `decorateContext`.

## Patterns

- Prefer `symbol` tokens for uniqueness.
- For scoped lifetimes, create one scope per request and dispose it.
- Inject factories instead of concrete instances for transients to avoid heavy allocations.

## Example: Per-request DB + Logger

```ts
import { ServiceCollection } from "@circulo-ai/di";
import { db } from "./db";

const TYPES = {
  Db: Symbol("Db"),
  Logger: Symbol("Logger"),
} as const;

const services = new ServiceCollection()
  .addScoped(TYPES.Db, () => db) // replace with tx-bound client if needed
  .addScoped(TYPES.Logger, () => {
    const requestId = crypto.randomUUID();
    return {
      info: (msg: string, meta?: unknown) => console.log(requestId, msg, meta),
    };
  })
  .addSingleton("Config", async () => await loadConfig());

const provider = services.build();

await provider.withScope(async (scope) => {
  const logger = scope.resolve<typeof console>(TYPES.Logger);
  logger.info("hello");
  const maybeDb = scope.tryResolve(TYPES.Db); // undefined if not registered
  const allLoggers = scope.resolveAll(TYPES.Logger); // supports multiple
  const config = await scope.resolveAsync("Config"); // async factory
});
```

## Hono Middleware Pattern

```ts
import { bindToHono, createToken, decorateContext } from "@circulo-ai/di";
import { Hono } from "hono";

const TYPES = { Logger: createToken<typeof console>("logger") };
const app = new Hono();
bindToHono(app as any, provider, TYPES, { cache: true, strict: true });
app.use("*", decorateContext(TYPES, { targetVar: "svc" }) as any);

app.get("/example", (c) => {
  const logger = (c as any).di.Logger;
  logger.info("handled request");
  return c.json({ ok: true });
});
```

## Disposal Semantics

- On `scope.dispose()`, any scoped instance with `dispose/close/destroy/Symbol.dispose/Symbol.asyncDispose` is called in reverse resolution order honoring `disposePriority`.
- On `provider.dispose()`, singleton disposables are called similarly. `addGlobalSingleton` instances live in `globalThis` and are not disposed automatically.
- Custom disposers on value providers: `addSingleton(token, { value, dispose })`.
- `scope.onDispose` / `provider.onDispose` let you register custom cleanup hooks (optionally with priority).
- `provider.withScope(fn)` creates/disposes a scope around a function call.
- Use this for DB clients, queues, or other handles that need cleanup.

## Testing

- Build a fresh `ServiceCollection` in tests and register fakes/stubs.
- For Hono handlers, create a scope, set it on `c.set("container", scope)`, and resolve services as usual.

## Publishing Checklist

1) `pnpm -C packages/di type-check`
2) `pnpm -C packages/di build`
3) `pnpm -C packages/di release` (builds and publishes with `--access public`)
