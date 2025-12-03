# @circulo-ai/di

A lightweight dependency injection toolkit with singleton, scoped, and transient lifetimes plus optional Hono helpers. No decorators, no reflect metadata—just factories and tokens.

## What's Inside

- **ServiceCollection**: Register services with lifetimes.
- **ServiceProvider**: Root container with singleton cache and scope creation.
- **ServiceScope**: Per-request/per-operation scoped instances with disposal.
- **Hono Helpers**: `createContainerMiddleware` to attach a scope to each request, `resolveFromContext`/`tryResolveFromContext` to fetch services.
- **Types**: `Token`, `ServiceDescriptor`, `ServiceLifetime`.

## Install

```bash
pnpm add @circulo-ai/di
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
services.addSingleton("Cache", () => primaryCache, { key: "primary", multiple: true });
services.addSingleton("Cache", () => secondaryCache, { key: "secondary", multiple: true });

const provider = services.build();
const scope = provider.createScope();

const config = scope.resolve<{ port: number }>("Config");
const requestId = scope.resolve<string>("RequestId");
const primary = scope.resolve("Cache", "primary");
const caches = scope.resolveAll("Cache"); // [secondary, primary] (last wins unless keyed)

// Optional resolution
const maybeMissing = scope.tryResolve("Missing"); // undefined instead of throw
```

## Hono Integration

```ts
import {
  createContainerMiddleware,
  resolveFromContext,
  tryResolveFromContext,
} from "@circulo-ai/di";
import { Hono } from "hono";

const provider = services.build();
const app = new Hono();

app.use("*", createContainerMiddleware(provider));

app.get("/ping", (c) => {
  const requestId = resolveFromContext<string>(c, "RequestId");
  const optional = tryResolveFromContext<string>(c, "Maybe");
  return c.json({ ok: true, requestId, optional });
});
```

## Lifetimes

- **Singleton**: One instance for the app lifetime.
- **Scoped**: One instance per `ServiceScope` (commonly per request).
- **Transient**: New instance every resolution.

## Disposal

If a resolved instance exposes `dispose`, `close`, or `destroy`, scopes and providers will call them when disposed.

```ts
const scope = provider.createScope();
// ...use services
await scope.dispose(); // cleans up scoped disposables
await provider.dispose(); // cleans up singletons
```

## Developing

```bash
pnpm -C packages/di type-check
pnpm -C packages/di build
```

## Publishing

```bash
pnpm -C packages/di release
```

The `release` script builds and publishes with `--access public`. `prepack` also runs the build automatically if you publish manually.
