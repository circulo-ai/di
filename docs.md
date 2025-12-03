# DI Package Guide

## Core APIs

- `ServiceCollection`: register services with `addSingleton`, `addScoped`, `addTransient`.
- `ServiceProvider`: built from a collection; resolves singletons and creates scopes.
- `ServiceScope`: per-request resolver that caches scoped instances and disposes them.
- `ServiceLifetime`: enum of `Singleton`, `Scoped`, `Transient`.
- `Token<T>`: string | symbol | class constructor; used to identify registrations.
- `resolve` vs `tryResolve`: `resolve` throws if missing; `tryResolve` returns `undefined`.
- `has`: check if a token is registered.

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
  });

const provider = services.build();
const scope = provider.createScope();
const logger = scope.resolve<typeof console>(TYPES.Logger);
logger.info("hello");
const maybeDb = scope.tryResolve(TYPES.Db); // undefined if not registered
await scope.dispose();
```

## Hono Middleware Pattern

```ts
import {
  createContainerMiddleware,
  resolveFromContext,
  tryResolveFromContext,
} from "@circulo-ai/di";
import { Hono } from "hono";

const app = new Hono();
app.use("*", createContainerMiddleware(provider));

app.get("/example", (c) => {
  const logger = resolveFromContext<typeof console>(c, TYPES.Logger);
  const maybeDb = tryResolveFromContext<typeof db>(c, TYPES.Db);
  logger.info("handled request");
  return c.json({ ok: true, hasDb: Boolean(maybeDb) });
});
```

## Disposal Semantics

- On `scope.dispose()`, any scoped instance with `dispose/close/destroy` is called.
- On `provider.dispose()`, singleton disposables are called.
- Use this for DB clients, queues, or other handles that need cleanup.

## Testing

- Build a fresh `ServiceCollection` in tests and register fakes/stubs.
- For Hono handlers, create a scope, set it on `c.set("container", scope)`, and resolve services as usual.

## Publishing Checklist

1) `pnpm -C packages/di type-check`
2) `pnpm -C packages/di build`
3) `pnpm -C packages/di release` (builds and publishes with `--access public`)
