import { injectable } from "@circulo-ai/di";
import { DI_TOKENS } from "./tokens";

export class TimeService {
  now(): string {
    return new Date().toISOString();
  }
}

@injectable([DI_TOKENS.TimeService])
export class GreetingService {
  constructor(private readonly clock: TimeService) {}

  greet(name: string): string {
    return `Hello, ${name}! The time is ${this.clock.now()}.`;
  }
}
