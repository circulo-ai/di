export class TimeService {
  now(): string {
    return new Date().toISOString();
  }
}

export class GreetingService {
  constructor(private readonly clock: TimeService) {}

  greet(name: string): string {
    return `Hello, ${name}! The time is ${this.clock.now()}.`;
  }
}
