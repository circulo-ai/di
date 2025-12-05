import { createContainerMiddleware } from "@circulo-ai/di";
import { Hono } from "hono";
import { buildProvider, type RequestScope } from "./container";
import { requestDi } from "./di-context";

export type AppEnv = {
  Variables: {
    container: RequestScope;
  };
};

const app = new Hono<AppEnv>();
const provider = buildProvider();

app.use("*", createContainerMiddleware<RequestScope, AppEnv>(provider));
app.use("*", requestDi);

app.get("/", (c) => {
  const greeting = c.di.GreetingService.greet("Hono + DI");
  return c.json({ greeting });
});

app.get("/time", (c) => c.text(c.di.TimeService.now()));

export default app;
