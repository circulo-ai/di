import app from "./app";

const response = await app.request("http://localhost/");
const body = (await response.json()) as { greeting?: string };

if (!response.ok || !body.greeting?.startsWith("Hello, Hono + DI!")) {
  throw new Error("The annotated Hono DI example failed its smoke test.");
}

console.log("annotated Hono example passed");
