# Hono + @circulo-ai/di (minimal example)

Tiny example showing how to wire the DI container into a Hono app and access services via `c.di`.

## Run it

```bash
pnpm install     # from repo root to link workspace deps
pnpm --filter hono dev
# or with bun directly: bun install && bun run dev
```

Visit http://localhost:3000 and http://localhost:3000/time.

## How it works

1) Define tokens and build a provider (`src/container.ts`)
```ts
export const DI_TOKENS = {
  GreetingService: Symbol("GreetingService"),
  TimeService: Symbol("TimeService"),
} as const;

services.addSingleton(DI_TOKENS.TimeService, () => new TimeService());
services.addScoped(
  DI_TOKENS.GreetingService,
  (resolver) => new GreetingService(resolver.resolve(DI_TOKENS.TimeService)),
);
```

2) Expose a typed `c.di` proxy (`src/di-context.ts`)
```ts
export const requestDi = createContextDiProxy<typeof DI_TOKENS, RequestScope>(
  DI_TOKENS,
);
```

3) Attach middleware in the app (`src/app.ts`)
```ts
app.use("*", createContainerMiddleware<RequestScope, AppEnv>(provider));
app.use("*", requestDi);
```

4) Augment Hono `Context` so TypeScript knows about `c.di` (`src/types/hono-di.d.ts`)
```ts
declare module "hono" {
  interface Context {
    di: RequestServices;
  }
}
```

5) Use services in routes (`src/app.ts`)
```ts
app.get("/", (c) => c.json({ greeting: c.di.GreetingService.greet("Hono + DI") }));
```
