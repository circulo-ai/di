import { createContextDiProxy, type ServicesFromTokens } from "@circulo-ai/di";
import { DI_TOKENS, type RequestScope } from "./container";

export type RequestServices = ServicesFromTokens<typeof DI_TOKENS>;

export const requestDi = createContextDiProxy<typeof DI_TOKENS, RequestScope>(
  DI_TOKENS,
);
