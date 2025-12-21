import type { ServiceCollection } from "../core/service-collection";
import type { BindingOptions, Token } from "../core/types";
import { createBinder } from "./binding";

type ModuleAction = (services: ServiceCollection) => void;

export interface ServiceModule {
  bind<T>(token: Token<T>): ReturnType<ReturnType<typeof createBinder>>;
  applyTo(services: ServiceCollection): void;
}

export function createModule(): ServiceModule {
  const actions: ModuleAction[] = [];

  const binder = createBinder(
    <T>(
      token: Token<T>,
      factory: (resolver: any) => unknown,
      options?: BindingOptions,
    ) => {
      actions.push((services) => services.addBinding(token, factory, options));
    },
  );

  return {
    bind: binder,
    applyTo(services: ServiceCollection) {
      for (const action of actions) {
        action(services);
      }
    },
  };
}
