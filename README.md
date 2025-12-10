# @circulo-ai/di

A lightweight dependency injection toolkit with singleton, scoped, global-singleton, and transient lifetimes plus Hono helpers. No decorators, no reflect metadata—just factories and tokens (sync or async).

## What's Inside

- **ServiceCollection**: Register services with lifetimes (`Singleton`, `GlobalSingleton`, `Scoped`, `Transient`), defaults (allowOverwrite/defaultMultiple), metadata (registeredAt/source), and dispose priorities.
- **ServiceProvider**: Root container with singleton/global caches, async-aware resolution, scopes, disposal hooks, tracing, and `withScope`.
- **ServiceScope**: Per-request/per-operation scoped instances with disposal ordering and async caching.
- **Hono Helpers**: `bindToHono` for one-liner setup; `decorateContext` for “put it on `c.var`”; strict/memoized proxies.
- **Tokens**: `createToken`, `optional(token)` for optional resolution; keyed/multi registrations; `resolveMap` for keyed lookups; `factory`/`lazy` helpers.
- **Diagnostics**: `validateGraph`, runtime circular detection, structured errors with path/token.
- **Conditional registration**: `ifProd`, `ifDev`, `ifTruthy`.

## Install

```bash
bun add @circulo-ai/di
```

## Quickstart

```ts
import { ServiceCollection, ServiceLifetime } from "@circulo-ai/di";

const services = new ServiceCollection();

// Singleton
services.addSingleton("Config", { port: 3000 });

// Scoped (e.g., per request)
services.addScoped("RequestId", () => crypto.randomUUID());

// Transient
services.addTransient("Now", () => () => new Date());

// Multiple/Keyed registrations
services.addSingleton("Cache", () => primaryCache, {
  key: "primary",
  multiple: true,
});
services.addSingleton("Cache", () => secondaryCache, {
  key: "secondary",
  multiple: true,
});

const provider = services.build();
const scope = provider.createScope();

const config = scope.resolve<{ port: number }>("Config");
const requestId = scope.resolve<string>("RequestId");
const primary = scope.resolve("Cache", "primary");
const caches = scope.resolveAll("Cache"); // [secondary, primary] (last wins unless keyed)
const byKey = scope.resolveMap("Cache"); // { primary: primaryCache, secondary: secondaryCache }

// Optional resolution
const maybeMissing = scope.tryResolve("Missing"); // undefined instead of throw
const maybeMissing2 = scope.resolve(optional("Missing")); // undefined

// Async factories
services.addSingleton("AsyncDb", async () => connectDb());
const db = await provider.resolveAsync("AsyncDb");
// provider.resolve("AsyncDb") will throw while the async factory is in-flight

// Factory/lazy helpers
services.addTransient("DbFactory", factory("AsyncDb"));
services.addScoped("LazyConfig", lazy("Config"));
```

## Hono Integration

```ts
import { bindToHono, createToken, decorateContext } from "@circulo-ai/di";
import { Hono } from "hono";

const TYPES = { RequestId: createToken<string>("requestId") } as const;
const provider = services.build();
const app = new Hono();

bindToHono(app as any, provider, TYPES, { cache: true, strict: true });
app.use("*", decorateContext(TYPES, { targetVar: "svc" }) as any);

app.get("/ping", (c) => {
  return c.json({
    ok: true,
    requestId: (c as any).di.RequestId,
    viaVar: (c.var as any).svc.RequestId,
  });
});
```

## Lifetimes

- **Singleton**: One instance for the app lifetime (per provider).
- **GlobalSingleton**: One instance per process (hot-reload safe via `globalThis`).
- **Scoped**: One instance per `ServiceScope` (commonly per request).
- **Transient**: New instance every resolution.

## Disposal

If a resolved instance exposes `dispose`, `close`, `destroy`, `Symbol.dispose`, or `Symbol.asyncDispose`, scopes and providers will call them when disposed. You can also register manual hooks with `scope.onDispose` / `provider.onDispose`, or run work in `provider.withScope(fn)` to auto-dispose.

- Scoped instances dispose in reverse resolve order; use `disposePriority` to override (higher runs first). Singletons honor the same priority and order.
- Custom disposers on value providers: `addSingleton(token, { value, dispose })`.

## Recipes

- **Connection pool (global)**  
  `addGlobalSingleton(CacheToken, () => createPool(), { disposePriority: 5 })`
- **Per-request transaction**  
  `addScoped(TxToken, (r) => startTx(r.resolve(DbToken)), { disposePriority: 10 })`
- **Background job scope**  
  `provider.withScope(async (scope) => { const job = scope.resolve(Job); await job.run(); })`
- **Testing overrides**  
  Build a fresh `ServiceCollection` in tests and register fakes; set `allowOverwrite: false` in prod to catch duplicate registrations; use `useExisting` to alias/mirror tokens for mocks.
- **Keyed multi-binding**  
  `resolveMap(Cache)` to pick keyed implementations; `validateGraph` warns about mixed keyed/unkeyed.
- **Async factory pattern**  
  Use `resolveAsync` for async factories; sync `resolve` throws `AsyncFactoryError` while the promise is in flight.

```ts
const scope = provider.createScope();
// ...use services
await scope.dispose(); // cleans up scoped disposables
await provider.dispose(); // cleans up singletons
```

## Developing

```bash
bun --cwd packages/di run typecheck
bun --cwd packages/di run build
```

## Publishing

```bash
bun -cwd packages/di run release
```

The `release` script builds and publishes with `--access public`. `prepack` also runs the build automatically if you publish manually.
