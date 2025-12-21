import { ServiceLifetime } from "../core/lifetime";
import type {
  BindingOptions,
  BindingScope,
  DependencyArray,
  DependencyObject,
  ServiceFactory,
  ServiceFactoryResult,
  ServiceResolver,
  Token,
  TokenLike,
} from "../core/types";

export type BinderRegister = <T>(
  token: Token<T>,
  factory: ServiceFactory<T>,
  options?: BindingOptions,
) => void;

export function scopeToLifetime(
  scope?: BindingScope,
): ServiceLifetime | undefined {
  switch (scope) {
    case "singleton":
      return ServiceLifetime.Singleton;
    case "global":
    case "globalSingleton":
      return ServiceLifetime.GlobalSingleton;
    case "scoped":
      return ServiceLifetime.Scoped;
    case "transient":
      return ServiceLifetime.Transient;
    default:
      return undefined;
  }
}

export function createBinder(register: BinderRegister) {
  return function bind<T>(token: Token<T>) {
    const registerWithOptions = (
      factory: ServiceFactory<T>,
      options?: BindingOptions,
    ) => {
      const normalized: BindingOptions = {
        ...options,
        lifetime:
          options?.lifetime ??
          scopeToLifetime(options?.scope) ??
          ServiceLifetime.Singleton,
      };
      register(token, factory, normalized);
    };

    return {
      toValue(value: T, options?: BindingOptions) {
        registerWithOptions(() => value, options);
      },
      toFunction(value: T, options?: BindingOptions) {
        registerWithOptions(() => value, options);
      },
      toFactory(
        factory: (resolver: ServiceResolver) => unknown,
        options?: BindingOptions,
      ) {
        registerWithOptions(
          (resolver) => factory(resolver) as ServiceFactoryResult<T>,
          options,
        );
      },
      toHigherOrderFunction(
        fn: CallableFunction,
        dependencies?: DependencyArray | DependencyObject,
        options?: BindingOptions,
      ) {
        const asyncMode = options?.async ?? false;
        if (asyncMode) {
          registerWithOptions(async (resolver) => {
            const deps = await resolveDependencies(
              resolver,
              dependencies,
              true,
            );
            return invokeWithDependencies(fn, deps) as ServiceFactoryResult<T>;
          }, options);
          return;
        }
        registerWithOptions((resolver) => {
          const deps = resolveDependencies(resolver, dependencies, false);
          return invokeWithDependencies(fn, deps) as T;
        }, options);
      },
      toCurry(
        fn: CallableFunction,
        dependencies?: DependencyArray | DependencyObject,
        options?: BindingOptions,
      ) {
        return this.toHigherOrderFunction(fn, dependencies, options);
      },
      toClass(
        Klass: new (...args: any[]) => T,
        dependencies?: DependencyArray | DependencyObject,
        options?: BindingOptions,
      ) {
        const asyncMode = options?.async ?? false;
        if (asyncMode) {
          registerWithOptions(async (resolver) => {
            const deps = await resolveDependencies(
              resolver,
              dependencies,
              true,
            );
            return constructWithDependencies(
              Klass,
              deps,
            ) as ServiceFactoryResult<T>;
          }, options);
          return;
        }
        registerWithOptions((resolver) => {
          const deps = resolveDependencies(resolver, dependencies, false);
          return constructWithDependencies(Klass, deps) as T;
        }, options);
      },
    };
  };
}

function invokeWithDependencies(fn: CallableFunction, deps: unknown): unknown {
  if (deps === undefined) return fn();
  if (Array.isArray(deps)) return (fn as any)(...deps);
  return (fn as any)(deps);
}

function constructWithDependencies<T>(
  Klass: new (...args: any[]) => T,
  deps: unknown,
): T {
  if (deps === undefined) return new Klass();
  if (Array.isArray(deps)) return new Klass(...deps);
  return new Klass(deps as any);
}

function resolveDependencies(
  resolver: ServiceResolver,
  dependencies: DependencyArray | DependencyObject | undefined,
  asyncMode: boolean,
): any {
  if (!dependencies) return undefined;

  if (Array.isArray(dependencies)) {
    return asyncMode
      ? Promise.all(
          dependencies.map((d) =>
            resolver.resolveAsync(d as TokenLike<unknown>),
          ),
        )
      : dependencies.map((d) => resolver.resolve(d as TokenLike<unknown>));
  }

  const entries = Object.entries(dependencies);
  if (asyncMode) {
    return Promise.all(
      entries.map(async ([name, dep]) => [
        name,
        await resolver.resolveAsync(dep as TokenLike<unknown>),
      ]),
    ).then(Object.fromEntries);
  }
  return Object.fromEntries(
    entries.map(([name, dep]) => [
      name,
      resolver.resolve(dep as TokenLike<unknown>),
    ]),
  );
}
