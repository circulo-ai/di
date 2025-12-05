import {
  ServiceCollection,
  type ServiceProvider,
  type Token,
} from "@circulo-ai/di";
import { GreetingService, TimeService } from "./services";

export const DI_TOKENS = {
  GreetingService: Symbol("GreetingService") as Token<GreetingService>,
  TimeService: Symbol("TimeService") as Token<TimeService>,
} as const;

let rootProvider: ServiceProvider | null = null;

export type RequestScope = ReturnType<ServiceProvider["createScope"]>;

export function buildProvider(): ServiceProvider {
  if (rootProvider) return rootProvider;

  const services = new ServiceCollection();

  services.addSingleton(DI_TOKENS.TimeService, () => new TimeService());
  services.addScoped(
    DI_TOKENS.GreetingService,
    (resolver) => new GreetingService(resolver.resolve(DI_TOKENS.TimeService)),
  );

  rootProvider = services.build();
  return rootProvider;
}
