import { ServiceCollection, type ServiceProvider } from "@circulo-ai/di";
import { GreetingService, TimeService } from "./services";
import { DI_TOKENS } from "./tokens";
export { DI_TOKENS } from "./tokens";

let rootProvider: ServiceProvider | null = null;

export type RequestScope = ReturnType<ServiceProvider["createScope"]>;

export function buildProvider(): ServiceProvider {
  if (rootProvider) return rootProvider;

  const services = new ServiceCollection();

  services.addSingleton(DI_TOKENS.TimeService, () => new TimeService());
  services
    .bind(DI_TOKENS.GreetingService)
    .toAnnotatedClass(GreetingService, { scope: "scoped" });

  rootProvider = services.build();
  return rootProvider;
}
