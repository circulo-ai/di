# @circulo-ai/di

A lightweight, type-safe dependency injection toolkit with singleton, scoped, global-singleton, and transient lifetimes plus Hono and Next.js helpers. It is reflection-free by default, with optional class annotations that do not require `reflect-metadata`.

## What's Inside

- **ServiceCollection**: Register services with lifetimes (`Singleton`, `GlobalSingleton`, `Scoped`, `Transient`), defaults (allowOverwrite/defaultMultiple), metadata (registeredAt/source), and dispose priorities.
- **Binding DSL**: `services.bind(Token).toValue/toFunction/toFactory/toClass/toHigherOrderFunction` with array/object dependencies and `scope` aliases for lifetimes.
- **Optional annotations**: `injectable(dependencies)` or `annotate(Class, dependencies)` for reflection-free constructor injection.
- **ServiceProvider**: Root container with singleton/global caches, async-aware resolution, scopes, disposal hooks, tracing, and `withScope`.
- **ServiceScope**: Per-request/per-operation scoped instances with disposal ordering and async caching.
- **Hono Helpers**: `bindToHono` for one-liner setup; `decorateContext` for “put it on `c.var`”; strict/memoized proxies.
- **Service Locator**: `createServiceLocator` for typed, lazily-resolved proxies from nested token trees.
- **Tokens**: `createToken`, `optional(token)` for optional resolution; keyed/multi registrations; `resolveMap` for keyed lookups; `factory`/`lazy` helpers.
- **Diagnostics**: `validateGraph`, runtime circular detection, structured errors with path/token.
- **Conditional registration**: `ifProd`, `ifDev`, `ifTruthy`.

## Install

```bash
bun add @circulo-ai/di
```

## Quickstart

```ts
import {
  ServiceCollection,
  createToken,
  factory,
  lazy,
  optional,
} from "@circulo-ai/di";

const services = new ServiceCollection();
const TYPES = {
  Logger: createToken<Logger>("Logger"),
  Cache: createToken<Cache>("Cache"),
} as const;

// Singleton
services.addSingleton("Config", { port: 3000 });

// Scoped (e.g., per request)
services.addScoped("RequestId", () => crypto.randomUUID());

// Transient
services.addTransient("Now", () => () => new Date());

// Multiple/Keyed registrations
services.addSingleton(TYPES.Cache, () => primaryCache, {
  key: "primary",
  multiple: true,
});
services.addSingleton(TYPES.Cache, () => secondaryCache, {
  key: "secondary",
  multiple: true,
});

// Async factories
services.addSingleton("AsyncDb", async () => connectDb());

// Binding DSL with array/object deps and scope aliases
services
  .bind("Settings")
  .toHigherOrderFunction(
    (db, logger) => ({ db, logger }),
    ["AsyncDb", TYPES.Logger],
    { scope: "scoped", async: true },
  );
services.bind("Static").toValue("hi");
services.bind(TYPES.Logger).toClass(Logger);

// Factory/lazy helpers
services.addTransient("DbFactory", factory("AsyncDb"));
services.addScoped("LazyConfig", lazy("Config"));

const provider = services.build();

await provider.withScope(async (scope) => {
  const config = scope.resolve<{ port: number }>("Config");
  const requestId = scope.resolve<string>("RequestId");
  const primary = scope.resolve(TYPES.Cache, "primary");
  const caches = scope.resolveAll(TYPES.Cache); // registration order
  const byKey = scope.resolveMap(TYPES.Cache);
  const maybeMissing = scope.resolve(optional("Missing")); // undefined
  const db = await scope.resolveAsync("AsyncDb");
});
```

## Optional class annotations

Annotations are explicit and do not inspect TypeScript design types or load `reflect-metadata`. Array dependencies are passed as positional constructor arguments; object dependencies are passed as one object.

```ts
import { ServiceCollection, createToken, injectable } from "@circulo-ai/di";

const LOGGER = createToken<Logger>("Logger");

@injectable([LOGGER])
class UserService {
  constructor(readonly logger: Logger) {}
}

const services = new ServiceCollection().addSingleton(LOGGER, new Logger());
services.bind(UserService).toClass(UserService);

// If decorator syntax is disabled, use:
// annotate(UserService, [LOGGER]);
```

For a Microsoft.Extensions.DependencyInjection-style workflow, use the class as both implementation and token:

```ts
const services = new ServiceCollection()
  .addSingleton(Logger)
  .addScoped(UserService)
  .addTransient(CommandHandler);

const provider = services.buildServiceProvider({ validateOnBuild: true });
await provider.withScope(async (scope) => {
  const users = scope.serviceProvider.getRequiredService(UserService);
  const optionalCache = scope.getService(Cache); // undefined if unregistered
  const handlers = scope.getServices(CommandHandler);
});
```

## Service locator helper

```ts
import {
  ServiceCollection,
  createServiceLocator,
  createToken,
  optional,
} from "@circulo-ai/di";

const TYPES = {
  Config: createToken<{ port: number }>("Config"),
  Db: createToken<{ query: (sql: string) => Promise<unknown> }>("Db"),
} as const;

const services = new ServiceCollection()
  .addSingleton(TYPES.Config, { port: 3000 })
  .addSingleton(TYPES.Db, () => ({ query: async (_sql: string) => [] }));

const provider = services.build();
const scope = provider.createScope();
const locator = createServiceLocator(
  scope,
  {
    config: TYPES.Config,
    db: { primary: TYPES.Db, cache: optional("Cache") },
  },
  { cache: false, strict: true },
);

const config = locator.config;
const db = locator.db.primary;
const maybeCache = locator.db.cache;
```

## Fundamentals & best practices

- **Pick the right lifetime**: `GlobalSingleton` for expensive process-wide things (DB pools); `Singleton` for app-level caches; `Scoped` per request/task; `Transient` for pure, cheap objects. Avoid scoped resolution from the root—always resolve through a scope/middleware.
- **Prefer tokens over strings**: `createToken<T>("Name")` keeps types tight and avoids collision. Use `optional(token)` for soft dependencies.
- **Binder DSL for ergonomic wiring**: `bind(Token).toValue|toFactory|toClass|toHigherOrderFunction` with array/object deps; use `scope` for lifetimes and `{ async: true }` when dep factories are async.
- **.NET-style vocabulary**: annotated classes can self-register with `addSingleton(Class)`, `addScoped(Class)`, or `addTransient(Class)`. Use `buildServiceProvider`, `getRequiredService`, `getService`, and `getServices` when that reads more naturally to your team.
- **Keyed multi-bindings**: set `{ multiple: true, key: "primary" }` and use `resolveMap` for clarity; avoid mixing keyed/unkeyed for the same token.
- **Async factories**: always resolve with `resolveAsync`; sync resolve will throw while in flight. Use `factory(token)` to inject lazy calls and `lazy(token)` to memoize per scope.
- **Dispose eagerly**: wrap work in `provider.withScope` or `withRequestScope` (Next) and call `provider.dispose()` on shutdown. Add `disposePriority` for ordered teardown.
- **Modules for features**: group registrations with `createModule().bind(...).to...` and `services.addModule(module)` to keep domains isolated.
- **Environment guards**: wrap optional services with `ifProd/ifDev/ifTruthy` to keep registration clean.
- **Validate and trace**: run `provider.validateGraph({ throwOnError: true })` locally to catch duplicates/missing tokens; pass `trace` to `ServiceCollection` to log resolution paths during debugging.
- **Testing overrides**: set `allowOverwrite: true` in tests, re-register tokens with fakes, or compose a new `ServiceCollection` per test. Use `useExisting` to alias mocks without changing consumers.
- **Hot-reload safety**: prefer `GlobalSingleton` or `getGlobalProvider` in dev servers/Next.js to avoid duplicate pools. Set an explicit `globalKey` when the token itself is recreated during hot reload.
- **Edge vs Node**: on Edge runtimes, avoid `globalThis` if not needed; prefer scoped lifetimes and per-request factories for lightweight objects.
- **Avoid hidden singletons**: keep most services scoped/transient and only elevate to singleton/global when necessary; use `trace` to spot unintended sharing.

```ts
// Lifetime + binder examples
services
  .bind(createToken<Pool>("Db"))
  .toHigherOrderFunction(() => createPool(), [], { scope: "global" });
services
  .bind(createToken<RequestLogger>("Logger"))
  .toFactory((r) => makeRequestLogger(r.resolve("RequestId")), {
    scope: "scoped",
  });
services
  .bind(createToken<Feature>("Feature"))
  .toHigherOrderFunction((deps) => new Feature(deps), { config: "Config" });

provider.validateGraph({ throwOnError: true });
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

## Real-world examples

Executable examples are included with the package:

- [`examples/annotations.ts`](./examples/annotations.ts): positional and named annotation metadata, optional dependencies, async constructor dependencies, scoped lifetimes, and graph validation.
- [`examples/real-world.ts`](./examples/real-world.ts): Next.js-style request scopes, feature modules, keyed tokens, and background workers.
- [`examples/hono`](./examples/hono): a complete Hono server using an annotated request-scoped service.

Run the annotation example with `bun examples/annotations.ts` after building the package, or validate every example with `bun run test:examples`.

### Next.js App Route (Node/Edge)

```ts
// app/api/users/route.ts
import {
  getGlobalProvider,
  withRequestScope,
  ServiceCollection,
} from "@circulo-ai/di";
import { NextRequest } from "next/server";

const TYPES = { Db: "Db", Logger: "Logger" } as const;

// Reuse across hot reloads and edge invocations
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

export const GET = withRequestScope(
  provider,
  async (_req: NextRequest, ctx) => {
    const db = await ctx.container.resolveAsync(TYPES.Db);
    const logger = ctx.container.resolve(TYPES.Logger);
    const rows = await db.query("select * from users");
    logger.info("users fetched", { count: rows.length });
    return Response.json({ users: rows });
  },
);
```

### Modular feature wiring

```ts
// user.module.ts
import { createModule } from "@circulo-ai/di";
export const TYPES = { UserRepo: "UserRepo", GetUser: "GetUser" } as const;
const userModule = createModule();
userModule.bind(TYPES.UserRepo).toClass(UserRepository, { db: "Db" });
userModule
  .bind(TYPES.GetUser)
  .toHigherOrderFunction(
    (repo) => (id: string) => repo.findById(id),
    [TYPES.UserRepo],
  );

// app container
import { ServiceCollection } from "@circulo-ai/di";
import { userModule, TYPES as USER } from "./user.module";

const services = new ServiceCollection()
  .addGlobalSingleton("Db", () => createPool(), { disposePriority: 10 })
  .addModule(userModule);

const provider = services.build();
const scope = provider.createScope();
await scope.resolveAsync(USER.GetUser)("123");
```

### Background job scope with disposals

```ts
import { ServiceCollection } from "@circulo-ai/di";

const TYPES = { Queue: "Queue", JobLogger: "JobLogger" } as const;
const services = new ServiceCollection()
  .addGlobalSingleton(TYPES.Queue, () => connectQueue(), { disposePriority: 5 })
  .bind(TYPES.JobLogger)
  .toFactory(() => createJobLogger(), { scope: "scoped" });

const provider = services.build();

export async function handleJob(payload: any) {
  return provider.withScope(async (scope) => {
    const queue = scope.resolve(TYPES.Queue);
    const log = scope.resolve(TYPES.JobLogger);
    log.info("processing job", payload);
    await queue.ack(payload.id);
  });
}
```

## Lifetimes

- **Singleton**: One instance for the app lifetime (per provider).
- **GlobalSingleton**: One instance per token identity in the process. Supply `globalKey` for stable reuse when hot reload recreates a token.
- **Scoped**: One instance per `ServiceScope` (commonly per request).
- **Transient**: New instance every resolution.

## Disposal

If a resolved object exposes `dispose`, `close`, `destroy`, `Symbol.dispose`, or `Symbol.asyncDispose`, scopes and providers call it when disposed. Function-valued services are never invoked as disposers. You can also register manual hooks with `scope.onDispose` / `provider.onDispose`, or run work in `provider.withScope(fn)` to auto-dispose. A disposed scope is terminal and throws `DisposedScopeError` if reused.

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
bun --cwd packages/di run check
bun --cwd packages/di run test:examples
```

## Publishing

```bash
bun --cwd packages/di run release
```

The `release` script publishes with public access. npm runs `prepack`, which type-checks, tests, cleans stale output, and builds before creating the tarball.
