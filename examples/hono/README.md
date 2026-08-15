# Hono + @circulo-ai/di (minimal example)

Tiny example showing how to wire the DI container into a Hono app and access services via `c.di`.

## Run it

```bash
bun install     # from repo root to link workspace deps
bun --filter hono dev
# or with bun directly: bun install && bun run dev
```

Visit http://localhost:3000 and http://localhost:3000/time.

Run `bun src/smoke.ts` for a no-server integration check. It sends an in-memory request through the real middleware stack and verifies the annotated `GreetingService` resolves correctly.

## How it works

1. Define typed tokens (`src/tokens.ts`) and build a provider (`src/container.ts`)

```ts
export const DI_TOKENS = {
  GreetingService: createToken<GreetingService>("GreetingService"),
  TimeService: createToken<TimeService>("TimeService"),
} as const;

services.addSingleton(DI_TOKENS.TimeService, () => new TimeService());
services
  .bind(DI_TOKENS.GreetingService)
  .toAnnotatedClass(GreetingService, { scope: "scoped" });
```

The service declares its constructor dependency without `reflect-metadata`:

```ts
@injectable([DI_TOKENS.TimeService])
export class GreetingService {
  constructor(private readonly clock: TimeService) {}
}
```

2. Expose a typed `c.di` proxy (`src/di-context.ts`)

```ts
export const requestDi = createContextDiProxy<typeof DI_TOKENS, RequestScope>(
  DI_TOKENS,
);
```

3. Attach middleware in the app (`src/app.ts`)

```ts
app.use("*", createContainerMiddleware<RequestScope, AppEnv>(provider));
app.use("*", requestDi);
```

4. Augment Hono `Context` so TypeScript knows about `c.di` (`src/types/hono-di.d.ts`)

```ts
declare module "hono" {
  interface Context {
    di: RequestServices;
  }
}
```

5. Use services in routes (`src/app.ts`)

```ts
app.get("/", (c) =>
  c.json({ greeting: c.di.GreetingService.greet("Hono + DI") }),
);
```
