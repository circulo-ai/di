import app from "./app";

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({
    port,
    fetch: app.fetch,
  });
  console.log(`🚀 Hono DI example running at http://localhost:${port}`);
}

export default app;
