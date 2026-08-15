import { createToken } from "@circulo-ai/di";
import type { GreetingService, TimeService } from "./services";

export const DI_TOKENS = {
  GreetingService: createToken<GreetingService>("GreetingService"),
  TimeService: createToken<TimeService>("TimeService"),
} as const;
