# @circulo-ai/di

`@circulo-ai/di` is an explicit, typed dependency-injection container for TypeScript applications. It works in Node.js, Bun, Hono, Next.js, background jobs, tests, and Edge-oriented code.

The package gives you:

- Typed symbol and class tokens.
- Singleton, global-singleton, scoped, and transient lifetimes.
- Explicit factories and constructor injection without `reflect-metadata`.
- Async factories, keyed registrations, and multi-bindings.
- Request scopes with deterministic async disposal.
- Startup dependency diagnostics and resolution tracing.
- Modules, service locators, and framework adapters.
- Safe defaults for ownership, overwriting, and missing services.

The container is deliberately explicit. It does not scan files, infer erased TypeScript types, dynamically import arbitrary modules, or hide service ownership behind global mutable state.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Beginner guide](#beginner-guide)
- [Clean architecture and composition roots](#clean-architecture-and-composition-roots)
  - [Architecture rules that scale](#architecture-rules-that-scale)
- [Real-world lifetime and ownership patterns](#real-world-lifetime-and-ownership-patterns)
  - [HTTP, workers, and scheduled jobs](#http-workers-and-scheduled-jobs)
  - [Testing a clean architecture](#testing-a-clean-architecture)
- [Tokens](#tokens)
- [Registration APIs](#registration-apis)
  - [Explicit helpers](#explicit-helpers)
  - [Registration options](#registration-options)
- [Tsyringe-compatible API](#tsyringe-compatible-api)
  - [Container and providers](#container-and-providers)
  - [Interception and delayed cycles](#interception-and-delayed-cycles)
- [Coming from .NET](#coming-from-net)
- [Binding DSL](#binding-dsl)
- [Constructor injection without reflection](#constructor-injection-without-reflection)
- [Helper functions and environment-aware registration](#helper-functions-and-environment-aware-registration)
- [Resolving services](#resolving-services)
  - [Multi-bindings and keyed services](#multi-bindings-and-keyed-services)
- [Lifetimes and ownership](#lifetimes-and-ownership)
- [Disposal](#disposal)
- [Validation and diagnostics](#validation-and-diagnostics)
  - [Beautiful runtime graph reports](#beautiful-runtime-graph-reports)
- [Modules](#modules)
- [Typed service locator](#typed-service-locator)
- [Hono integration](#hono-integration)
- [Next.js integration](#nextjs-integration)
- [Testing and overrides](#testing-and-overrides)
- [Error behavior](#error-behavior)
- [Production checklist](#production-checklist)
- [Development and release](#development-and-release)
- [Migration from earlier versions](#migration-from-earlier-versions)
- [License](#license)

## Install

```bash
bun add @circulo-ai/di
# or
npm install @circulo-ai/di
```

Use the core entrypoint for container code:

```ts
import {
  ServiceCollection,
  createToken,
  injectable,
  optional,
} from "@circulo-ai/di";
```

Framework integrations have explicit subpath entrypoints:

```ts
import { bindToHono } from "@circulo-ai/di/hono";
import { getGlobalProvider, withRequestScope } from "@circulo-ai/di/next";
// Optional tree-shakeable compatibility entrypoints:
import { container } from "@circulo-ai/di/compat";
import { delay } from "@circulo-ai/di/compat/lazy";
```

The root entrypoint still exports the integration functions for backwards compatibility. Hono is an optional peer dependency; install it in applications that use the Hono adapter.

## Quick start

```ts
import { ServiceCollection, createToken, injectable } from "@circulo-ai/di";

type Config = { databaseUrl: string };
type Database = { query(sql: string): Promise<unknown[]> };
type Logger = { info(message: string): void };

const CONFIG = createToken<Config>("app.config");
const DATABASE = createToken<Database>("app.database");
const LOGGER = createToken<Logger>("app.logger");

const collection = new ServiceCollection();

collection
  .useValue(CONFIG, { databaseUrl: process.env.DATABASE_URL ?? "memory://dev" })
  .useFactory(DATABASE, async (services) => {
    const config = await services.resolveAsync(CONFIG);
    return connectDatabase(config.databaseUrl);
  })
  .useFactory(
    LOGGER,
    () => ({ info: (message: string) => console.log(`[app] ${message}`) }),
    { disposal: "scope" },
  );

@injectable([CONFIG, DATABASE, LOGGER])
class UserService {
  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly logger: Logger,
  ) {}

  async list() {
    this.logger.info(`reading from ${this.config.databaseUrl}`);
    return this.database.query("select * from users");
  }
}

collection.addSingleton(UserService);

const provider = collection.buildServiceProvider({ validateOnBuild: true });

await provider.withScope(async (scope) => {
  const users = await scope.resolve(UserService).list();
  console.log(users);
});

await provider.dispose();

function connectDatabase(url: string): Database {
  return { query: async (sql) => [{ url, sql }] };
}
```

Behavior:

1. `CONFIG` is one immutable value for the provider.
2. The database factory may be asynchronous and is resolved only when requested.
3. `UserService` is a provider singleton.
4. `withScope` creates and disposes a request-like scope even when the callback throws.
5. Calling `provider.dispose()` is terminal. Further resolution throws `DisposedProviderError`.

## Beginner guide

If dependency injection is new to you, start with four concepts:

1. A **token** is the runtime identity of a dependency, such as `LOGGER` or `UserRepository`.
2. A **registration** tells the collection how to create or provide that dependency.
3. A **provider** is the built, immutable-at-runtime composition that resolves registrations.
4. A **scope** is one isolated unit of work, such as an HTTP request or queue message.

You do not need decorators or `reflect-metadata` to get started. The most explicit beginner-friendly pattern is a token, a factory, and a provider:

```ts
import { ServiceCollection, createToken } from "@circulo-ai/di";

type Mailer = { send(to: string, body: string): Promise<void> };
const MAILER = createToken<Mailer>("notifications.mailer");

class WelcomeEmail {
  constructor(private readonly mailer: Mailer) {}

  send(to: string) {
    return this.mailer.send(to, "Welcome to the product");
  }
}

const provider = new ServiceCollection()
  .useValue(MAILER, {
    send: async (to, body) => console.log({ to, body }),
  })
  .useFactory(
    WelcomeEmail,
    (services) => new WelcomeEmail(services.resolve(MAILER)),
  )
  .buildServiceProvider({ validateOnBuild: true });

await provider.resolve(WelcomeEmail).send("user@example.com");
await provider.dispose();
```

As projects grow, move the registration chain into a bootstrap function and keep business code dependent on interfaces/tokens. Use `useValue` for an already-created value, `useFactory` when creation needs other services, and `useClass` or `addTransient`/`addScoped` when a class should be constructed by DI. Prefer `resolveAsync` whenever a factory or dependency can be asynchronous.

Common beginner mistakes are creating a provider inside every function, resolving dependencies from domain code, using a singleton for request state, and swallowing resolution errors with broad `try/catch`. The [clean architecture](#clean-architecture-and-composition-roots), [lifetime](#real-world-lifetime-and-ownership-patterns), and [production checklist](#production-checklist) sections show the safe progression from a small application to a service with multiple adapters and runtimes.

## Clean architecture and composition roots

Use DI at the application boundary, where concrete infrastructure is assembled. Keep the domain and application layers independent from `ServiceCollection`, `ServiceProvider`, framework adapters, and the global compatibility `container`.

```text
HTTP / jobs / CLI
       │
       ▼
Composition root ──────── wires tokens to adapters and chooses lifetimes
       │
       ▼
Application services ──── use cases and orchestration
       │
       ▼
Domain ports ───────────── interfaces and business rules
       ▲
       │
Infrastructure adapters ─ database, queues, email, APIs, files
```

The dependency direction should point toward stable policy. Define ports next to the domain or application use case, then implement them in infrastructure. The composition root is the only place that should know both sides:

```ts
// application/user-ports.ts
export type User = { id: string; email: string };

export interface UserRepository {
  findByEmail(email: string): Promise<User | undefined>;
}

export const USER_REPOSITORY = createToken<UserRepository>(
  "application.user-repository",
);
export const REQUEST_CONTEXT = createToken<{ requestId: string }>(
  "application.request-context",
);

// application/register-user.ts
@injectable([USER_REPOSITORY, REQUEST_CONTEXT])
export class RegisterUser {
  constructor(
    private readonly users: UserRepository,
    private readonly request: { requestId: string },
  ) {}

  async execute(email: string) {
    const existing = await this.users.findByEmail(email);
    return { existing, requestId: this.request.requestId };
  }
}

// infrastructure/postgres-user-repository.ts
export class PostgresUserRepository implements UserRepository {
  constructor(private readonly database: Database) {}

  async findByEmail(email: string) {
    return this.database.query<User>(
      "select id, email from users where email = $1",
      [email],
    );
  }
}

// bootstrap/create-runtime.ts — the composition root
export function createRuntime(config: AppConfig) {
  const collection = new ServiceCollection()
    .useValue(APP_CONFIG, config)
    .useFactory(
      DATABASE,
      (services) => connectDatabase(services.resolve(APP_CONFIG).databaseUrl),
      { disposal: "provider", dependencies: [APP_CONFIG] },
    )
    .useFactory(
      USER_REPOSITORY,
      (services) => new PostgresUserRepository(services.resolve(DATABASE)),
      { disposal: "provider", dependencies: [DATABASE] },
    )
    .useFactory(REQUEST_CONTEXT, () => ({ requestId: crypto.randomUUID() }), {
      disposal: "scope",
    })
    .addScoped(RegisterUser);

  return collection.buildServiceProvider({
    validateOnBuild: true,
    requireKeysForMultiple: true,
  });
}
```

The example uses explicit tokens at the boundary and keeps `RegisterUser` unaware of PostgreSQL. For a stateless application service, `addSingleton` is also appropriate; use `addScoped` when the service holds request state or depends on a scoped service.

Resolve a request or job inside one scope and let the provider own process-level resources:

```ts
const provider = createRuntime(config);

try {
  // HTTP request, queue message, scheduled job, or CLI command:
  return await provider.withScope(async (scope) => {
    return scope.resolve(RegisterUser).execute("user@example.com");
  });
} finally {
  await provider.dispose();
}
```

For a long-running server, create the provider once during bootstrap, call `withScope` for each request or job, and dispose it during graceful shutdown. Never create a new provider per request: that defeats singleton reuse and makes resource ownership difficult to reason about.

### Architecture rules that scale

- Keep registration in one composition root per application process or isolated runtime.
- Inject ports (`UserRepository`) and tokens, not infrastructure classes, into use cases.
- Keep domain objects constructible without a container. Pass domain dependencies through application services or explicit constructors.
- Use modules or `registerFeature(collection)` functions to group feature registrations, but apply them only from the composition root.
- Keep framework-specific resolution at adapters/controllers. A controller may resolve an application service; a domain entity should never resolve from a container.
- Treat the global Tsyringe-compatible `container` as a migration or integration boundary. Prefer an explicitly built provider for new application code.
- Name tokens by bounded context (`billing.payment-gateway`, `identity.user-repository`) so collisions are obvious in diagnostics.

## Real-world lifetime and ownership patterns

Choose a lifetime from the state and resource being managed, not from the class name:

| Situation                                                           | Recommended lifetime | Typical examples                                           |
| ------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| Immutable configuration or shared client                            | `Singleton`          | environment config, database pool, HTTP client             |
| One instance per request/job                                        | `Scoped`             | request context, transaction, authorization snapshot       |
| Stateless short-lived operation                                     | `Transient`          | command handler, formatter, mapper                         |
| One instance per `resolve` call graph                               | `ResolutionScoped`   | correlation-aware resolver helpers                         |
| One instance per container, including child-container compatibility | `ContainerScoped`    | container-local caches and registries                      |
| Truly process-wide resource                                         | `GlobalSingleton`    | use sparingly; explicit global ownership is harder to test |

A singleton must be safe for concurrent callers and must not retain scoped state. If a singleton needs request data, pass that data into a method or move the dependent service to `Scoped`. `validateGraph()` can detect common captive-dependency mistakes when registrations declare their dependencies.

For disposable resources, make ownership explicit:

```ts
collection.useFactory(DATABASE, connectDatabase, {
  disposal: "provider", // close once during application shutdown
});

collection.addScoped(REQUEST_TRANSACTION, createTransaction, {
  disposal: "scope", // rollback/close at the end of each request or job
});
```

Use `disposal: "none"` only when another system owns the resource. If ownership is unclear, the registration is not ready for production.

### HTTP, workers, and scheduled jobs

The same scope boundary works across runtimes:

```ts
async function handleHttpRequest(provider: ServiceProvider) {
  return provider.withScope(async (scope) => {
    const handler = scope.resolve(UserRequestHandler);
    return handler.handle();
  });
}

async function processMessage(provider: ServiceProvider, message: Message) {
  return provider.withScope(async (scope) => {
    const handler = scope.resolve(MessageHandler);
    return handler.handle(message);
  });
}
```

`withScope` disposes scoped instances on success and failure. For Hono and Next.js, use the package adapters described below; for other frameworks, wrap the framework handler or worker callback with the same pattern.

### Testing a clean architecture

Build the same composition root with test adapters rather than mocking the provider:

```ts
const testCollection = new ServiceCollection()
  .useValue(APP_CONFIG, { databaseUrl: "memory://test" })
  .useValue(USER_REPOSITORY, new InMemoryUserRepository())
  .useFactory(REQUEST_CONTEXT, () => ({ requestId: "test-request" }), {
    disposal: "scope",
  })
  .addScoped(RegisterUser);

const testProvider = testCollection.buildServiceProvider({
  validateOnBuild: true,
});

await testProvider.withScope(async (scope) => {
  const result = await scope.resolve(RegisterUser).execute("user@example.com");
  expect(result.requestId).toBe("test-request");
});
await testProvider.dispose();
```

Use a fresh collection/provider per test. Enable `{ allowOverwrite: true }` only for deliberate, local overrides; `useValue` is usually clearer and safer than replacing production descriptors after the provider has been built.

## Tokens

Tokens are runtime values, so they survive TypeScript compilation and can be used safely in factories, decorators, tests, and adapters.

```ts
const CLOCK = createToken<{ now(): Date }>("clock");

collection.useValue(CLOCK, { now: () => new Date() });
const clock = provider.resolve(CLOCK); // { now(): Date }
```

Class constructors are also tokens:

```ts
class AuditService {}
collection.addSingleton(AuditService);
provider.resolve(AuditService);
```

String tokens are supported for compatibility, but symbols or classes avoid accidental collisions:

```ts
const CACHE = Symbol("cache");
collection.useValue(CACHE, new Map());
```

Use `optional(token)` when absence is a valid configuration state:

```ts
const METRICS = createToken<{ count(name: string): void }>("metrics");
const metrics = provider.resolve(optional(METRICS)); // value or undefined
```

An optional dependency returns `undefined` only when the registration is absent. Factory failures and circular dependencies still throw.

## Registration APIs

### Explicit helpers

| API                            | Meaning                                      | Default lifetime |
| ------------------------------ | -------------------------------------------- | ---------------- |
| `useValue(token, value)`       | Register a value exactly as provided         | Singleton        |
| `useFactory(token, factory)`   | Register a resolver-aware factory            | Singleton        |
| `useClass(token, Klass)`       | Construct a class with explicit dependencies | Singleton        |
| `useExisting(token, existing)` | Alias one token to another                   | Singleton        |

`useValue` is the safe way to register a function as a service: it stores the function instead of invoking it. The legacy `addSingleton(token, fn)` overload treats a function as a factory for compatibility.

```ts
const HANDLER = createToken<(input: string) => string>("handler");
collection.useValue(HANDLER, (input) => input.toUpperCase());
```

Factories receive a resolver and can resolve synchronously or asynchronously:

```ts
collection.useFactory(CACHE, (services) => {
  const config = services.getRequiredService(CONFIG);
  return createCache(config.databaseUrl);
});

collection.useFactory(CLOCK, async () => ({ now: () => new Date() }));
const clock = await provider.resolveAsync(CLOCK);
```

`addSingleton`, `addGlobalSingleton`, `addScoped`, and `addTransient` are useful when the lifetime is the important part of the registration:

```ts
collection.addSingleton(CONFIG, { databaseUrl: "memory://dev" });
collection.addGlobalSingleton(CACHE, () => new Map());
collection.addScoped(REQUEST_ID, () => crypto.randomUUID());
collection.addTransient(REQUEST_LOGGER, () => new RequestLogger());
```

Class tokens can self-register when their constructor has no parameters or has `@injectable` metadata:

```ts
collection.addSingleton(UserService);
collection.addScoped(RequestContext);
collection.addTransient(RequestLogger);
```

Registrations reject accidental overwrites. Create a collection with `{ allowOverwrite: true }` for controlled test overrides:

```ts
const tests = new ServiceCollection({ allowOverwrite: true });
tests.useValue(CONFIG, { databaseUrl: "memory://test" });
tests.useValue(CONFIG, { databaseUrl: "memory://fixture" });
```

### Registration options

```ts
collection.useFactory(PLUGIN, createPlugin, {
  key: "payments",
  multiple: true,
  disposePriority: 100,
  source: "payments-module",
  dependencies: [CONFIG],
  disposal: "provider",
});
```

- `key` identifies a keyed registration.
- `multiple: true` keeps the registration alongside existing registrations.
- `disposePriority` controls teardown order; higher priorities dispose first.
- `source` and `captureStack` improve diagnostics.
- `dependencies` declares dependencies for startup graph validation.
- `disposal` controls who owns cleanup: `none`, `scope`, `provider`, or `global`.
- `globalKey` gives global-singletons an explicit process-wide identity.

## Tsyringe-compatible API

If your team is familiar with Microsoft’s Tsyringe, the package also exposes a migration-friendly `container` API. It keeps the same core guarantees—explicit runtime tokens, deterministic disposal, async-safe resolution, and no mandatory `reflect-metadata`—while providing familiar names and provider shapes.

```ts
import {
  Lifecycle,
  container,
  inject,
  injectAll,
  injectable,
  singleton,
} from "@circulo-ai/di";

const DATABASE = Symbol("Database");

@injectable()
class UserService {
  constructor(
    @inject(DATABASE) private readonly database: Database,
    @injectAll("UserPlugin", { isOptional: true })
    private readonly plugins: UserPlugin[],
  ) {}
}

@singleton()
class Metrics {}

container.register(DATABASE, { useValue: createDatabase() });
container.register(
  "UserPlugin",
  { useClass: AuditPlugin },
  {
    lifecycle: Lifecycle.Singleton,
    multiple: true,
  },
);
container.register(UserService, UserService);

const users = container.resolve(UserService);
```

The decorator metadata is recorded directly on the class. `@inject`, `@injectAll`, `@injectWithTransform`, and `@injectAllWithTransform` work with `experimentalDecorators` and do not require a `reflect-metadata` import. `@injectable()` can use parameter decorators without emitted design metadata; for undecorated class parameters, enable TypeScript design metadata and provide the usual Reflect polyfill if your application wants that convenience.

Supported decorators and equivalents:

| API                                                 | Purpose                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `injectable()`                                      | Mark a class as constructible by the container.                                                                                                    |
| `singleton()` / `@singleton()`                      | Register a class as a provider singleton in the global `container`.                                                                                |
| `autoInjectable()`                                  | Return a class whose zero-argument construction resolves its parameters from the global `container`; explicit constructor arguments are preserved. |
| `inject(token, { isOptional })`                     | Inject one token. Optional injection returns `undefined` only when it is unregistered.                                                             |
| `injectAll(token, { isOptional })`                  | Inject all registrations as an array; optional missing tokens return `[]`.                                                                         |
| `injectWithTransform(token, transform, ...args)`    | Resolve one value and pass it through a transformer object, transformer class token, or function.                                                  |
| `injectAllWithTransform(token, transform, ...args)` | Resolve all values and transform the resulting array.                                                                                              |
| `scoped(Lifecycle.*)`                               | Register a class as `Transient`, `Singleton`, `ResolutionScoped`, or `ContainerScoped`.                                                            |
| `registry([...])`                                   | Register providers when the decorated module is imported.                                                                                          |

```ts
class FeatureFlags {
  enabled(name: string) {
    return name === "new-checkout";
  }
}

class Checkout {
  constructor(
    @injectWithTransform(
      "Flags",
      (flags: FeatureFlags, name: string) => flags.enabled(name),
      "new-checkout",
    )
    readonly newCheckout: boolean,
  ) {}
}
```

`Lifecycle.ResolutionScoped` reuses one instance during a single dependency graph and starts fresh for the next top-level resolve. `Lifecycle.ContainerScoped` reuses one instance per `Container`, so child containers get independent instances. `Lifecycle.Singleton` is provider-local; use `GlobalSingleton` through the native `ServiceCollection` API only when process-wide/hot-reload reuse is intentional.

### Container and providers

```ts
import {
  Lifecycle,
  container,
  instanceCachingFactory,
  instancePerContainerCachingFactory,
  predicateAwareClassFactory,
} from "@circulo-ai/di";

container.registerType("PrimaryLogger", "Logger");
container.registerInstance("BuildInfo", { version: "1.0.0" });
container.registerSingleton("Database", Database);
container.register("LazyCache", {
  useFactory: instanceCachingFactory((c) => c.resolve(Cache)),
});
container.register("PerContainerCache", {
  useFactory: instancePerContainerCachingFactory((c) => c.resolve(Cache)),
});
container.register("HttpClient", {
  useFactory: predicateAwareClassFactory(
    (c) => c.resolve("Config").https,
    HttpsClient,
    HttpClient,
  ),
});

const allPlugins = container.resolveAll<UserPlugin>("UserPlugin");
const child = container.createChildContainer();
child.register("Config", { useValue: { https: false } });
child.isRegistered("Logger", true); // includes parent registrations
```

`register` accepts class, value, factory, and token providers. Factory providers receive a contextual container, so resolution-scoped lifetimes remain correct inside nested `resolve` calls. `reset()` clears registrations and interceptors; `clearInstances()` keeps registrations but recreates cached singleton/container-scoped instances. `dispose()` is terminal and disposes instances owned by that container.

### Interception and delayed cycles

```ts
container.beforeResolution(
  "Database",
  (_token, type) => {
    console.debug("resolving", type);
  },
  { frequency: "Once" },
);

container.afterResolution("Database", (_token, database) => {
  database.healthcheck();
});
```

For a cycle that cannot be refactored immediately, use a delayed constructor. The returned proxy resolves the target only when first accessed:

```ts
class A {
  constructor(@inject(delay(() => B)) readonly b: B) {}
}
class B {
  constructor(@inject(delay(() => A)) readonly a: A) {}
}
```

Prefer refactoring cycles where possible. Delayed proxies are synchronous and should not be used to hide an async initialization boundary.

## Coming from .NET

If you are coming from `Microsoft.Extensions.DependencyInjection`, the mental model is familiar: register services in an `IServiceCollection`-like composition phase, build a provider, create a scope per unit of work, resolve application services, and dispose the provider during shutdown. The main difference is that TypeScript erases interfaces and generic types at runtime, so contracts must use explicit tokens or classes.

### Core mapping

| .NET DI concept                    | `@circulo-ai/di` equivalent                             | Important difference                                                               |
| ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `IServiceCollection`               | `ServiceCollection`                                     | The collection is the registration builder; use it only during composition.        |
| `IServiceProvider`                 | `ServiceProvider`                                       | `resolve` is required; `getService`/`tryResolveMissing` are the optional variants. |
| `AddSingleton`                     | `addSingleton`, `useValue`, or `useFactory`             | A singleton is provider-owned by default when disposable.                          |
| `AddScoped`                        | `addScoped` or `useFactory(..., { disposal: "scope" })` | A scope must be created explicitly with `withScope` or `createScope`.              |
| `AddTransient`                     | `addTransient`                                          | Transients are new for each resolution unless you choose another lifetime.         |
| `IServiceScope` / `CreateScope()`  | `ServiceScope` / `createScope()`                        | Prefer `withScope` so cleanup is guaranteed on every error path.                   |
| `IEnumerable<T>`                   | `resolveAll(T)`                                         | Use `multiple: true` for each registration.                                        |
| Keyed services                     | `key` plus `resolve(token, key)` or `resolveMap(token)` | Keys are explicit runtime values, including strings, numbers, and symbols.         |
| `ImplementationFactory`            | `useFactory` or `bind(...).toFactory(...)`              | Factories can return promises; use the async resolver for async graphs.            |
| `ValidateOnBuild`                  | `buildServiceProvider({ validateOnBuild: true })`       | Declare hidden factory dependencies with `dependencies` for useful validation.     |
| `IOptions<T>`                      | A typed token registered with `useValue`                | Validate and freeze configuration before registering it.                           |
| `IDisposable` / `IAsyncDisposable` | `dispose`, `close`, or `destroy` plus disposal policy   | Ownership is explicit: `scope`, `provider`, `global`, or `none`.                   |
| `IHostedService`                   | An application-owned startup/shutdown coordinator       | Register its resources and call `provider.dispose()` during graceful shutdown.     |

### A .NET-style registration extension

In .NET, feature packages commonly expose `AddOrders(IServiceCollection services)`. The equivalent is a function that accepts and returns the collection. It should register a feature’s ports and adapters without resolving anything while the module is being composed:

```ts
export function addOrders(collection: ServiceCollection): ServiceCollection {
  return collection
    .useFactory(
      ORDER_REPOSITORY,
      (services) => new PostgresOrderRepository(services.resolve(DATABASE)),
      { dependencies: [DATABASE], disposal: "provider" },
    )
    .addScoped(PlaceOrder);
}

const provider = addOrders(
  addIdentity(new ServiceCollection().useValue(APP_CONFIG, config)),
).buildServiceProvider({ validateOnBuild: true });
```

When using this pattern, keep feature functions deterministic and side-effect free. Database connections, network clients, and worker startup should happen when the registered factory is resolved, not while the module file is imported.

### Configuration and options

Use a token for each cohesive configuration contract instead of injecting a stringly typed environment lookup throughout the application:

```ts
type PaymentsOptions = {
  apiUrl: string;
  timeoutMs: number;
};

const PAYMENTS_OPTIONS = createToken<PaymentsOptions>("payments.options");

const options = parseAndValidatePaymentsEnv(process.env);
const collection = new ServiceCollection().useValue(PAYMENTS_OPTIONS, options);
```

This is the practical equivalent of binding a `.NET` options section. Keep parsing, validation, defaults, and secrets handling outside the domain. Register an immutable value, and inject the typed token into the adapter that needs it.

### Scopes, async work, and disposal

The closest equivalent to ASP.NET Core’s request scope or a scoped background operation is:

```ts
async function executeRequest(provider: ServiceProvider, input: Input) {
  return provider.withScope(async (scope) => {
    return scope.resolve(RequestHandler).handle(input);
  });
}
```

Do not keep a `ServiceScope` in a singleton, global variable, or promise that outlives the request. For workers, create one scope per message or job. For a process-wide database pool or HTTP client, register it as a singleton and dispose the provider once during shutdown. If initialization is asynchronous, call `resolveAsync` at the boundary and let the provider track the resulting resource.

### TypeScript-specific guidance

- Interfaces are erased, so `constructor(repository: UserRepository)` cannot identify a service by itself. Use `@inject(USER_REPOSITORY)`, `@injectable([USER_REPOSITORY])`, or an explicit factory.
- TypeScript generics are also erased. Register separate runtime tokens for concepts such as `IValidator<User>` and `IValidator<Order>`.
- Do not recreate .NET’s ambient `IServiceProvider` pattern everywhere. Keep resolution in composition roots, controllers, message handlers, and framework adapters.
- Use `resolveAll` for plugin pipelines and `key` for a deliberate strategy choice. Use a normal interface/token when there should be exactly one implementation.
- `GlobalSingleton` is not a default replacement for a .NET singleton. Choose it only when the same instance must be shared across separately built providers.
- `ServiceCollection` is not a service locator. Build once, pass the provider or scoped resolver only to the boundary that owns the operation, and inject dependencies into the application layer.

The migration path is usually: convert interfaces to tokens, move `Add*` methods into feature registration functions, wrap each request/job in `withScope`, add `validateOnBuild`, then make disposal ownership explicit. The [Tsyringe-compatible API](#tsyringe-compatible-api) is useful when migrating an existing decorator-oriented TypeScript codebase; new code generally benefits from the explicit core API.

## Binding DSL

`bind(token)` provides a compact adapter-oriented API:

```ts
collection.bind(CONFIG).toValue({ databaseUrl: "memory://dev" });
collection.bind(HANDLER).toFunction((input: string) => input.toUpperCase());
collection.bind(REPOSITORY).toFactory((services) => {
  return new UserRepository(services.resolve(DATABASE));
});
collection.bind(USER_SERVICE).toClass(UserService, [DATABASE, LOGGER]);
```

Available methods:

- `toValue(value)` and `toFunction(value)` register values.
- `toFactory(factory)` receives the resolver and returns the service.
- `toHigherOrderFunction(fn, dependencies)` resolves dependencies and calls `fn`.
- `toCurry(fn, dependencies)` is an alias for `toHigherOrderFunction`.
- `toClass(Klass, dependencies)` constructs a class.
- `toAnnotatedClass(Klass)` uses `@injectable`/`annotate` metadata.

Dependencies can be positional or named:

```ts
collection
  .bind(REPOSITORY)
  .toHigherOrderFunction(
    (database, logger) => new UserRepository(database, logger),
    [DATABASE, LOGGER],
    { scope: "scoped" },
  );

collection
  .bind(USE_CASE)
  .toClass(
    UserUseCase,
    { repository: REPOSITORY, metrics: optional(METRICS) },
    { scope: "scoped" },
  );
```

Set `{ async: true }` when dependency resolution or construction is asynchronous:

```ts
collection
  .bind(DATABASE)
  .toHigherOrderFunction(
    async (config) => connectDatabase(config.databaseUrl),
    [CONFIG],
    { async: true },
  );
```

## Constructor injection without reflection

TypeScript erases constructor parameter types. `@circulo-ai/di` therefore requires explicit metadata instead of relying on reflection.

```ts
const LOGGER = createToken<Logger>("logger");

@injectable([LOGGER])
class BillingService {
  constructor(private readonly logger: Logger) {}
}

collection.addScoped(BillingService);
```

The decorator is optional; `annotate` is useful when decorators are not enabled:

```ts
class BillingService {
  constructor(private readonly logger: Logger) {}
}

annotate(BillingService, [LOGGER]);
collection.addScoped(BillingService);
```

Named dependencies make larger constructors easier to review:

```ts
class ReportService {
  constructor(
    private readonly deps: {
      database: Database;
      logger: Logger;
    },
  ) {}
}

collection.bind(ReportService).toAnnotatedClass(ReportService);
annotate(ReportService, { database: DATABASE, logger: LOGGER });
```

If a class declares constructor parameters without metadata, registration or resolution fails with a message explaining how to add metadata. No constructor is guessed from emitted JavaScript.

## Helper functions and environment-aware registration

The helper functions cover common adapter and lazy-resolution patterns:

```ts
import {
  factory,
  ifDev,
  ifProd,
  ifTruthy,
  lazy,
  useClass,
  useExisting,
  withScope,
} from "@circulo-ai/di";

// Inject a function that resolves the current token on demand.
collection.bind(GET_DATABASE).toFactory(factory(DATABASE));

// Inject a memoized thunk. The first call resolves the token; later calls reuse it.
collection.bind(GET_CONFIG).toFactory(lazy(CONFIG));

ifProd(collection, (services) => {
  services.addSingleton(CACHE, () => new RedisCache());
});
ifDev(collection, (services) => {
  services.addSingleton(CACHE, () => new MemoryCache());
});
ifTruthy(collection, "ENABLE_SEARCH", (services) => {
  services.addSingleton(SEARCH, () => new SearchClient());
});

// The helper versions register aliases/classes as multi-bindings by default.
useExisting(collection, PUBLIC_REPOSITORY, INTERNAL_REPOSITORY);
useClass(collection, PLUGIN, PaymentsPlugin, {
  lifetime: "transient",
  key: "payments",
});

await withScope(provider, async (scope) => {
  return scope.resolve(UserService).list();
});
```

`ifProd` and `ifDev` inspect `NODE_ENV`; in an Edge runtime with no `process`, they use the safe development default. `ifTruthy` registers only when the named environment variable is present and truthy. The helper `useExisting` and `useClass` are convenient multi-binding helpers; use the collection methods when you need every registration option or replacement semantics.

## Resolving services

The provider owns application-wide registrations. A scope is a resolver with request-local instances:

```ts
const provider = collection.build();

const scope = provider.createScope();
try {
  const service = scope.getRequiredService(UserService);
  const maybeMetrics = scope.getService(METRICS);
} finally {
  await scope.dispose();
}
```

Prefer `withScope` for request and job handlers:

```ts
const result = await provider.withScope(async (scope) => {
  return scope.resolve(UserService).list();
});
```

Use `resolve` for synchronous factories and `resolveAsync` for async factories:

```ts
const config = provider.resolve(CONFIG);
const database = await provider.resolveAsync(DATABASE);
```

Resolving an async factory synchronously throws `AsyncFactoryError`. This prevents a pending promise from being mistaken for a service.

### Multi-bindings and keyed services

```ts
const PLUGIN = createToken<{ name: string; run(): Promise<void> }>("plugin");

collection.addTransient(PLUGIN, () => new PaymentsPlugin(), {
  key: "payments",
  multiple: true,
});
collection.addTransient(PLUGIN, () => new SearchPlugin(), {
  key: "search",
  multiple: true,
});

const plugins = provider.resolveAll(PLUGIN);
const pluginsAsync = await provider.resolveAllAsync(PLUGIN);
const byName = await provider.resolveMapAsync(PLUGIN);
```

`resolveMap` and `resolveMapAsync` require unique keys. Missing registrations return an empty array/map. Duplicate or missing keys throw before an async map is materialized.

Useful aliases:

- `getRequiredService` is an explicit alias for `resolve`.
- `getService` returns `undefined` when a registration is absent.
- `getServices` and `getServicesAsync` are aliases for multi-resolution.
- `tryResolveMissing` and `tryResolveMissingAsync` suppress only `MissingServiceError`.
- Legacy `tryResolve`/`tryResolveAsync` suppress all errors; use the missing-only variants when factory failures must remain visible.

## Lifetimes and ownership

| Lifetime          | Instance identity                            | Default cleanup owner |
| ----------------- | -------------------------------------------- | --------------------- |
| `singleton`       | One per provider                             | Provider              |
| `globalSingleton` | Shared through `globalThis` across providers | Global registry       |
| `scoped`          | One per request/job scope                    | Scope                 |
| `transient`       | New instance per resolution                  | Caller by default     |

Resolving a scoped service from the root provider throws `ScopeResolutionError`. This prevents a request-owned object from escaping into application-wide state.

```ts
collection.addScoped(REQUEST_CONTEXT, () => ({
  requestId: crypto.randomUUID(),
}));

await provider.withScope(async (scope) => {
  console.log(scope.resolve(REQUEST_CONTEXT).requestId);
});
```

## Disposal

Disposable instances may expose `dispose`, `close`, `destroy`, `Symbol.asyncDispose`, or `Symbol.dispose`. The first available protocol is used.

```ts
class DatabaseConnection {
  async close() {
    console.log("database closed");
  }
}

collection.addSingleton(DATABASE, () => new DatabaseConnection());
const provider = collection.build();
provider.resolve(DATABASE);
await provider.dispose(); // database closed
```

Ownership is explicit:

```ts
// A transient is caller-owned by default.
collection.addTransient(CLIENT, () => new Client());

// This transient is disposed with its request scope.
collection.addTransient(REQUEST_CLIENT, () => new Client(), {
  disposal: "scope",
});

// This value is closed when the provider is disposed.
collection.useValue(CACHE, new Cache(), { disposal: "provider" });
```

`disposal: "none"` disables automatic cleanup. Global singletons are intentionally not disposed by an individual provider because other providers may still use them:

```ts
await provider.dispose();
await disposeGlobalServices();
```

Disposal is reverse-order within the same priority. Higher `disposePriority` values run first. All cleanup is attempted; multiple failures are reported as an `AggregateError` so one broken resource does not hide the others.

Register custom cleanup hooks when the resource is external to a service instance:

```ts
provider.onDisposeWithPriority(() => metrics.flush(), 50);
```

Both providers and scopes are terminal after disposal. Concurrent disposal calls share the same completion and do not double-close resources.

## Validation and diagnostics

Declare dependencies when a factory has dependencies hidden inside a closure:

```ts
collection.addSingleton(
  APP,
  (services) => {
    return new App(services.resolve(CONFIG));
  },
  { dependencies: [CONFIG], source: "app.ts" },
);
```

Validate before accepting traffic:

```ts
const provider = collection.buildServiceProvider({
  validateOnBuild: true,
  requireKeysForMultiple: true,
});
```

Validation reports missing dependencies, dependency cycles, captive dependencies such as a singleton depending on a scoped service, and invalid multi-binding keys. With `throwOnError: false`, `provider.validateGraph()` returns diagnostics:

```ts
[
  {
    level: "error",
    message: "Singleton service App depends on scoped service RequestContext.",
    token: App,
    path: [App, RequestContext],
  },
];
```

Graph validation can inspect declared metadata only. Dependencies obtained through arbitrary runtime control flow should be declared explicitly.

For startup debugging, capture registration locations and resolution events:

```ts
const collection = new ServiceCollection({
  captureStack: true,
  trace: (event) => console.debug("DI", event),
});

const provider = collection.build();
console.log(provider.getDescriptors(App));
```

Descriptors include token, lifetime, key, source, registration time, ownership, and priority. Tracing is useful in development; avoid logging secrets or enabling verbose tracing on hot production paths without a sampling policy.

### Beautiful runtime graph reports

The development-only graph recorder turns real resolution activity into an identity-safe snapshot. It captures dynamic factory lookups, keyed services, lifetimes, resolution counts, async usage, roots, and cycles. Because it observes runtime behavior, it complements (rather than replaces) `validateGraph()` and declared `dependencies`.

```ts
import { ServiceCollection } from "@circulo-ai/di";
import {
  RuntimeDependencyGraph,
  writeDependencyGraphReport,
} from "@circulo-ai/di/devtools";

const provider = new ServiceCollection()
  .addSingleton(CONFIG, config)
  .addTransient(
    UserRepository,
    (services) => new UserRepository(services.resolve(CONFIG)),
  )
  .addTransient(
    UserService,
    (services) => new UserService(services.resolve(UserRepository)),
  )
  .build();

const graph = new RuntimeDependencyGraph();
const stopRecording = graph.attach(provider);

try {
  await provider.resolveAsync(UserService);
  await writeDependencyGraphReport("./di-runtime.html", graph.snapshot(), {
    title: "Circulo DI · runtime graph",
  });
} finally {
  stopRecording();
  await provider.dispose();
}
```

Open `di-runtime.html` locally. The report is fully offline and includes search, hot-path filtering, pan/zoom, node inspection, lifetime and async badges, resolution counts, dependent/dependency lists, and cycle highlighting. For tooling that does not write files, use `graph.snapshot()` with `renderDependencyGraphHtml(snapshot)` from the package root. The graph contains service metadata only—never resolved instance values.

## Modules

Modules keep feature registrations local and composable:

```ts
import { createModule } from "@circulo-ai/di";

const paymentsModule = createModule();
paymentsModule.bind(PaymentService).toClass(PaymentService, undefined, {
  scope: "scoped",
});
paymentsModule
  .bind(PaymentGateway)
  .toFactory((resolver) => new PaymentGateway(resolver.resolve(CONFIG)), {
    scope: "transient",
  });

const collection = new ServiceCollection().addModule(paymentsModule);
```

Modules record bindings and apply them later to a `ServiceCollection`, so feature registrations can be composed without a service locator or global registry. `createModule()` currently exposes the binding DSL; use `collection.addModule(module)` at the composition root.

## Typed service locator

For application composition roots or controllers that benefit from grouped access, use `createServiceLocator`:

```ts
const services = createServiceLocator(
  provider,
  {
    config: CONFIG,
    users: {
      service: UserService,
      repository: REPOSITORY,
    },
  },
  { cache: true, strict: true },
);

await services.users.service.list();
```

The returned object is typed from the token tree. `cache`/`memoize` caches property resolutions; leave it disabled when transient semantics matter. `strict` throws for unknown locator properties instead of returning `undefined`.

## Hono integration

The Hono adapter creates one scope per request and disposes it after the handler, including error paths.

```ts
import { Hono } from "hono";
import { ServiceCollection, createToken } from "@circulo-ai/di";
import { bindToHono, resolveFromContext } from "@circulo-ai/di/hono";

const REQUEST_ID = createToken<string>("request.id");
const collection = new ServiceCollection().addScoped(REQUEST_ID, () =>
  crypto.randomUUID(),
);
const provider = collection.build();
const app = new Hono();

bindToHono(app, provider, { requestId: REQUEST_ID }, { strict: true });

app.get("/", (c) => {
  const id = resolveFromContext(c, REQUEST_ID);
  return c.json({ requestId: id });
});
```

The response is shaped like this:

```json
{ "requestId": "a fresh UUID for this request" }
```

`bindToHono` exposes `c.var.container` and a lazy `c.di` locator. Use `cache: true` when repeated property access should resolve once per request. Use `decorateContext` when you prefer eagerly resolved named values in `c.var.services`:

```ts
app.use("*", decorateContext({ requestId: REQUEST_ID }));
```

If the handler and scope cleanup both fail, the adapter throws an `AggregateError` containing both errors. The original request error is never silently replaced.

## Next.js integration

Reuse a provider across development hot reloads and create a scope per route invocation:

```ts
// lib/di.ts
import { ServiceCollection } from "@circulo-ai/di";
import { getGlobalProvider } from "@circulo-ai/di/next";

export const provider = getGlobalProvider(() => {
  return new ServiceCollection().addSingleton(AppService).build();
});
```

```ts
// app/api/users/route.ts
import { withRequestScope } from "@circulo-ai/di/next";
import { provider } from "@/lib/di";

export const GET = withRequestScope(
  provider,
  async (_request, { container }) => {
    const users = await container.resolveAsync(UserService);
    return Response.json(users.list());
  },
);
```

`getGlobalProvider` stores one provider under a stable `globalThis` key, which avoids duplicate singleton graphs during hot reload. `withRequestScope` disposes scoped services after every invocation and preserves both handler and cleanup failures. The adapter is runtime-agnostic; keep Node-only dependencies out of Edge route modules and use a provider factory appropriate for the deployment runtime.

## Testing and overrides

Build a fresh collection per test. Replace ports with in-memory adapters rather than mocking container internals:

```ts
const collection = new ServiceCollection();
collection
  .useValue(CONFIG, { databaseUrl: "memory://test" })
  .useValue(DATABASE, { query: async () => [{ id: 1 }] })
  .addScoped(UserService);

const provider = collection.buildServiceProvider({ validateOnBuild: true });
await provider.withScope(async (scope) => {
  expect(await scope.resolve(UserService).list()).toEqual([{ id: 1 }]);
});
await provider.dispose();
```

For an intentional override, use `new ServiceCollection({ allowOverwrite: true })` or register a keyed fake with `multiple: true`. Avoid sharing providers between tests unless the test is specifically verifying global lifetime behavior.

## Error behavior

| Error                     | Meaning                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `MissingServiceError`     | A required token or key is not registered. Includes the token and resolution path. |
| `CircularDependencyError` | The current resolution path contains the same token/key twice.                     |
| `AsyncFactoryError`       | A promise-producing factory was resolved through the synchronous API.              |
| `ScopeResolutionError`    | A scoped service was requested without a scope.                                    |
| `DisposedScopeError`      | A disposed scope was used.                                                         |
| `DisposedProviderError`   | A disposed provider was used.                                                      |

Treat factory and disposal errors as application failures. Use `tryResolveMissing` only around genuinely optional registrations; broad error suppression can hide broken configuration.

## Production checklist

1. Use symbol or class tokens for shared contracts.
2. Call `buildServiceProvider({ validateOnBuild: true })` during startup.
3. Declare hidden factory dependencies with `dependencies`.
4. Use a scope for each HTTP request, queue job, or isolated unit of work.
5. Keep singletons free of scoped dependencies.
6. Decide ownership for every disposable external resource.
7. Dispose providers during graceful shutdown and call `disposeGlobalServices()` when the process is finished.
8. Keep `allowOverwrite` disabled outside controlled test composition.
9. Use keyed multi-bindings for plugins and strategy ports.
10. Keep registries and constructors application-owned; do not dynamically load untrusted modules.
11. Add idempotency and retry policy at the adapter boundary for at-least-once job systems.
12. Test cleanup failures and primary-error preservation, not just successful resolution.

## Development and release

From the repository root:

```bash
bun --filter @circulo-ai/di typecheck
bun --filter @circulo-ai/di test
bun --filter @circulo-ai/di build
bun --filter @circulo-ai/di check
npm pack --dry-run
```

`check` runs the complete package gate, including tests, build, package smoke tests, and example typechecks. `prepack` runs `check`, so the tarball cannot be created successfully while the package gate is failing.

Releases use Changesets and GitHub Actions trusted publishing:

```bash
bunx changeset
bun run version-packages
```

The version workflow creates or updates the release pull request. After that pull request is merged into the configured release branch, the publish workflow installs with the lockfile, typechecks/builds/tests public packages, and runs Changesets publish with npm OIDC trusted publisher permissions. No local npm token or manual `npm publish` is required.

## Migration from earlier versions

Existing `addSingleton`, `addScoped`, `addTransient`, `bind`, `resolve`, and `createScope` composition remains supported. Adopt the newer APIs incrementally:

```diff
- collection.addSingleton("config", () => config);
+ collection.useValue(CONFIG, config);

- const request = provider.createScope();
- try { return handler(request); } finally { await request.dispose(); }
+ return provider.withScope(handler);

- provider.tryResolve(OPTIONAL_SERVICE); // hides all failures
+ provider.tryResolveMissing(OPTIONAL_SERVICE); // hides absence only
```

The compatibility baseline is the same resolver model. New ownership, async multi-resolution, diagnostics, and subpath adapters are additive; they do not require rewriting existing registrations.

## License

Apache-2.0
