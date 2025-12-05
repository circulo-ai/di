import type { RequestServices } from "../di-context";

declare module "hono" {
  interface Context {
    di: RequestServices;
  }
}
