# @circulo-ai/di Guide

Everything you need to wire services with predictable lifetimes, explicit disposal, and great DX.

## Quick start

```ts
import {
  ServiceCollection,
  ServiceLifetime,
  createToken,
  optional,
} from "@circulo-ai/di";

const TYPES = {
  Db: createToken("db"),
  Logger: createToken("logger"),
  Clock: createToken<Date>("clock"),
};

const services = new ServiceCollection({
  allowOverwrite: false,
  trace: console.debug,
})
  .addGlobalSingleton(TYPES.Db, async () => createPool()) // survives hot-reload
  .addScoped(TYPES.Logger, () => makeRequestLogger()) // per-request
  .addTransient(TYPES.Clock, () => new Date()); // every resolve

const provider = services.build();

// per-request/operation
await provider.withScope(async (scope) => {
  const db = await scope.resolveAsync(TYPES.Db);
  const logger = scope.resolve(TYPES.Logger);
  logger.info("running");
  const maybeFeature = scope.resolve(optional(createToken("featureFlag"))); // undefined if missing
});
```

## Core concepts

- **ServiceCollection**: register descriptors with lifetimes (`Singleton`, `GlobalSingleton`, `Scoped`, `Transient`). Options: `allowOverwrite`, `defaultMultiple`, `trace`, `captureStack`.
- **Tokens**: prefer `createToken<T>()` for type safety; `optional(token)` for safe miss returns `undefined`.
- **Resolver APIs**: `resolve`, `resolveAsync`, `tryResolve*`, `resolveAll`, `resolveMap` (keyed), `has`, `getDescriptor(s)`.
- **Scopes**: created per request/task; cache scoped instances; dispose in reverse resolution order honoring `disposePriority`. Hooks: `onDispose`/`onDisposeWithPriority`.
- **Provider**: caches singletons/global singletons, exposes `withScope`, disposal hooks, tracing, graph validation, and circular detection.

## Registration helpers

- `useExisting(services, Alias, Source, { lifetime, key })`: alias another token, optionally keyed/multiple.
- `useClass(services, Token, Klass, { lifetime, key })`: construct class.
- `services.bind(Token)`: fluent DSL `toValue/toFunction/toFactory/toClass/toHigherOrderFunction` with array/object deps and `scope` aliases (`singleton|global|scoped|transient`).
- `factory(token)`: inject a resolver function to fetch a token on-demand.
- `lazy(token)`: memoized thunk per scope.
- `ifProd/ifDev/ifTruthy(envVar)`: conditional registration helpers.
- Value providers with disposal: `addSingleton(token, { value, dispose|close|destroy })`.

## Binding DSL

```ts
services
  .bind("Clock")
  .toHigherOrderFunction((deps) => () => deps.start, { start: "Start" });
services
  .bind("ScopedSettings")
  .toHigherOrderFunction((db, cache) => ({ db, cache }), ["Db", "Cache"], {
    scope: "scoped",
    async: true,
  });
services.bind(Logger).toClass(Logger, { sink: "Sink" });
```

## Lifetimes & disposal

- `Singleton`: once per provider; disposed on `provider.dispose()` in priority order (higher first, then reverse creation).
- `GlobalSingleton`: stored in `globalThis` across providers/hot reloads. Clear manually if needed.
- `Scoped`: once per scope; disposed on `scope.dispose()` with `disposePriority` and reverse resolution order.
- `Transient`: new instance each resolve; not cached or disposed automatically.
- Supported disposers: `dispose`, `close`, `destroy`, `Symbol.dispose`, `Symbol.asyncDispose`, or a custom disposer you attach to value providers.
- Hooks: `scope.onDispose*`, `provider.onDispose*`; `provider.withScope(fn)` wraps work with automatic dispose.

## Async factories

- Factories may return promises; use `resolveAsync/tryResolveAsync`. In-flight promises are deduped for the same descriptor (singleton/global/scoped).
- Sync resolve against an async factory throws `AsyncFactoryError` to avoid partial state.

## Keys, multiples, and maps

- Register multiple implementations with `{ multiple: true }`; optionally add `key`.
- `resolve(token, key?)` picks the last descriptor for unkeyed or the matching key.
- `resolveAll(token)` returns all instances.
- `resolveMap(token)` returns an object keyed by registration key and throws if unkeyed duplicates exist.

## Diagnostics & tracing

- Structured errors: `MissingServiceError`, `ScopeResolutionError`, `AsyncFactoryError`, `CircularDependencyError` include token/key/path breadcrumbs.
- `validateGraph({ throwOnError, requireKeysForMultiple, unusedTokens })` warns/errors about duplicate keys, mixed keyed/unkeyed, missing registrations, unused tokens.
- Tracing: pass `trace(event)` to `ServiceCollection` defaults to observe `{ token, key, lifetime, path, async }`.
- Metadata: descriptors include `registeredAt` and optional `source` (when `captureStack` enabled).

## Hono integration

- `createContainerMiddleware(provider, { variableName })`: attaches a new scope to each request.
- `createContextDiProxy(tokens, { propertyName, variableName, cache, strict })`: exposes typed proxy on context (default `c.di`), optional per-request memoization, and strict missing-token errors.
- `bindToHono(app, provider, tokens, { var, prop, cache, strict })`: installs both middleware in one call.
- `decorateContext(tokens, { variableName, targetVar })`: eagerly resolve and attach to `c.var`.
- `resolveFromContext/tryResolveFromContext(ctx, token, variableName?)`: fetch services from context.

## Next.js helpers

- `getGlobalProvider(factory, key?)`: memoize a provider on `globalThis` to survive hot reloads.
- `withRequestScope(provider, handler, { containerProp })`: wrap a handler so each call gets a scoped container injected on context and disposed automatically.

## Real-world examples

### Next.js route handler

```ts
// app/api/health/route.ts
import {
  getGlobalProvider,
  withRequestScope,
  ServiceCollection,
} from "@circulo-ai/di";

const TYPES = { Db: "Db", Logger: "Logger" } as const;

const provider = getGlobalProvider(() => {
  const services = new ServiceCollection();
  services
    .bind(TYPES.Db)
    .toHigherOrderFunction(() => createPool(), [], { scope: "global" });
  services
    .bind(TYPES.Logger)
    .toFactory(() => createRequestLogger(), { scope: "scoped" });
  return services.build();
});

export const GET = withRequestScope(provider, async (_req, ctx) => {
  const db = await ctx.container.resolveAsync(TYPES.Db);
  const logger = ctx.container.resolve(TYPES.Logger);
  const [{ now }] = await db.query("select now()");
  logger.info("healthcheck");
  return Response.json({ ok: true, now });
});
```

### Feature module composition

```ts
// notifications.module.ts
import { createModule } from "@circulo-ai/di";
export const TYPES = { Sender: "Sender", NotifyUser: "NotifyUser" } as const;

export const notifications = createModule()
  .bind(TYPES.Sender)
  .toHigherOrderFunction((deps) => new EmailSender(deps.config), {
    config: "Config",
  })
  .bind(TYPES.NotifyUser)
  .toHigherOrderFunction(
    (sender) => async (userId: string, message: string) =>
      sender.send(userId, message),
    [TYPES.Sender],
  );

// main container
const services = new ServiceCollection()
  .addSingleton("Config", loadConfig())
  .addModule(notifications);
const provider = services.build();
await provider.resolve(TYPES.NotifyUser)("123", "hi");
```

### Background worker scope

```ts
const TYPES = { Queue: "Queue", JobLogger: "JobLogger" } as const;
const services = new ServiceCollection()
  .addGlobalSingleton(TYPES.Queue, () => connectQueue())
  .bind(TYPES.JobLogger)
  .toFactory(() => createJobLogger(), { scope: "scoped" });

const provider = services.build();

export async function handleJob(job: Job) {
  return provider.withScope(async (scope) => {
    const queue = scope.resolve(TYPES.Queue);
    const log = scope.resolve(TYPES.JobLogger);
    log.info("processing", { id: job.id });
    await queue.ack(job.id);
  });
}
```

## Guards & graph safety

- Circular detection with breadcrumb paths.
- Scoped resolution from root throws `ScopeResolutionError`.
- Async factories resolved synchronously throw `AsyncFactoryError`.
- Optional tokens return `undefined` without throwing.

## Recipes

- **Global pool + per-request scope**
  ```ts
  const TYPES = { Pool: createToken("pool"), Tx: createToken("tx") };
  services
    .addGlobalSingleton(TYPES.Pool, () => createPool(), { disposePriority: 10 })
    .addScoped(TYPES.Tx, async (r) => r.resolve(TYPES.Pool).transaction());
  ```
- **Background job scope**
  ```ts
  await provider.withScope(async (scope) => {
    const jobLogger = scope.resolve(TYPES.Logger);
    const tx = await scope.resolveAsync(TYPES.Tx);
    // work...
  });
  ```
- **Keyed multi-binding**
  ```ts
  services
    .addTransient("Handler", () => handlerA, { key: "a", multiple: true })
    .addTransient("Handler", () => handlerB, { key: "b", multiple: true });
  const handlers = provider.resolveMap("Handler"); // { a, b }
  ```
- **Conditional registrations**
  ```ts
  ifProd(services, (s) => s.addSingleton("Cache", () => new RedisCache()));
  ifDev(services, (s) => s.addSingleton("Cache", () => new MemoryCache()));
  ifTruthy(services, "ENABLE_SEARCH", (s) =>
    s.addSingleton("Search", initSearch),
  );
  ```

## Real-world examples

### 1) Hono server with strict DI proxy

```ts
import { Hono } from "hono";
import { bindToHono, createToken, ServiceCollection } from "@circulo-ai/di";
import { createPool } from "./db";

const TYPES = {
  Db: createToken("db"),
  Logger: createToken<typeof console>("logger"),
};

const services = new ServiceCollection({ allowOverwrite: false })
  .addGlobalSingleton(TYPES.Db, () => createPool(), { disposePriority: 10 })
  .addScoped(TYPES.Logger, () => makeRequestLogger());

const provider = services.build();
const app = new Hono();
bindToHono(app as any, provider, TYPES, { cache: true, strict: true });

app.get("/health", (c) => c.json({ ok: true }));
app.get("/users", async (c) => {
  const { Db, Logger } = (c as any).di;
  const rows = await Db.query("select * from users");
  Logger.info("fetched users", { count: rows.length });
  return c.json(rows);
});
```

### 2) Background worker with scoped job resources

```ts
const TYPES = {
  Queue: createToken("queue"),
  JobLogger: createToken("jobLogger"),
};

const services = new ServiceCollection()
  .addGlobalSingleton(TYPES.Queue, () => connectQueue())
  .addScoped(TYPES.JobLogger, () => createJobLogger());

const provider = services.build();

export async function handleJob(payload: JobPayload) {
  return provider.withScope(async (scope) => {
    const queue = scope.resolve(TYPES.Queue);
    const log = scope.resolve(TYPES.JobLogger);
    log.info("processing job", payload.id);
    // ...
  });
}
```

### 3) Testing with overrides

```ts
const TYPES = { Service: createToken<string>("service") };
const services = new ServiceCollection({ allowOverwrite: true }).addSingleton(
  TYPES.Service,
  "real",
);

// override in tests
services.addSingleton(TYPES.Service, "fake");
const provider = services.build();

expect(provider.resolve(TYPES.Service)).toBe("fake");
```

### 4) Keyed multi-handler routing

```ts
type Handler = (input: string) => string;
const HANDLER = createToken<Handler>("handler");
const services = new ServiceCollection()
  .addTransient(HANDLER, () => (x) => x.toUpperCase(), {
    key: "up",
    multiple: true,
  })
  .addTransient(HANDLER, () => (x) => x.trim(), {
    key: "trim",
    multiple: true,
  });

const provider = services.build();
const map = provider.resolveMap(HANDLER);
console.log(map.up("hi"), map.trim(" hi "));
```

### 5) Optional dependency for feature flags

```ts
const CACHE = createToken<Cache>("cache");
const services = new ServiceCollection();
// only register when feature flag is set
ifTruthy(services, "ENABLE_CACHE", (s) =>
  s.addSingleton(CACHE, () => new Cache()),
);

const provider = services.build();
const cache = provider.resolve(optional(CACHE)); // Cache | undefined
```

## Checklist for consumers

- Use `createToken` + `bindToHono` with `strict: true` for handlers.
- Prefer `GlobalSingleton` for long-lived pools in serverless/hot-reload environments.
- Always dispose scopes for background tasks (`withScope`) and root provider on shutdown.
- Use `disposePriority` to close outward-facing servers before DB pools.
- Enable `trace` during development; run `validateGraph` in CI for guardrails.
