import {
  annotatedClassFactory,
  resolveInjectionParameters,
} from "../core/annotations.js";
import { ServiceLifetime } from "../core/lifetime.js";
import { ServiceCollection } from "../core/service-collection.js";
import type {
  ClassConstructor,
  ServiceResolver,
  Token,
  TokenLike,
} from "../core/types.js";

export enum Lifecycle {
  Transient,
  Singleton,
  ResolutionScoped,
  ContainerScoped,
}

type ResolutionType = "Single" | "All";
type InterceptorOptions = { frequency?: "Always" | "Once" };

type ValueProvider<T> = { useValue: T };
type FactoryProvider<T> = {
  useFactory: (container: DependencyContainer) => T | Promise<T>;
};
type TokenProvider<T> = { useToken: Token<T> };
type ClassProvider<T> = { useClass: ClassConstructor<T> };
export type Provider<T> =
  | ValueProvider<T>
  | FactoryProvider<T>
  | TokenProvider<T>
  | ClassProvider<T>;
export type FactoryFunction<T> = (
  container: DependencyContainer,
) => T | Promise<T>;
export type RegistrationOptions = {
  lifecycle?: Lifecycle;
  multiple?: boolean;
};

type PreResolutionInterceptorCallback<T = unknown> = (
  token: Token<T>,
  resolutionType: ResolutionType,
) => void;
type PostResolutionInterceptorCallback<T = unknown> = (
  token: Token<T>,
  result: T | T[],
  resolutionType: ResolutionType,
) => void;

export interface DependencyContainer extends ServiceResolver {
  register<T>(token: Token<T>, provider: ValueProvider<T>): this;
  register<T>(token: Token<T>, provider: FactoryProvider<T>): this;
  register<T>(
    token: Token<T>,
    provider: TokenProvider<T> | ClassProvider<T> | ClassConstructor<T>,
    options?: RegistrationOptions,
  ): this;
  registerSingleton<T>(from: Token<T>, to: Token<T>): this;
  registerSingleton<T>(token: ClassConstructor<T>): this;
  registerType<T>(from: Token<T>, to: Token<T>): this;
  registerInstance<T>(token: Token<T>, instance: T): this;
  isRegistered<T>(token: Token<T>, recursive?: boolean): boolean;
  reset(): void;
  clearInstances(): void;
  createChildContainer(): DependencyContainer;
  beforeResolution<T>(
    token: Token<T>,
    callback: PreResolutionInterceptorCallback<T>,
    options?: InterceptorOptions,
  ): void;
  afterResolution<T>(
    token: Token<T>,
    callback: PostResolutionInterceptorCallback<T>,
    options?: InterceptorOptions,
  ): void;
  dispose(): Promise<void>;
}

export class Container implements DependencyContainer {
  private readonly services: ServiceCollection;
  private readonly provider;

  constructor(private readonly parent?: Container) {
    this.services = new ServiceCollection({ allowOverwrite: true });
    this.provider = this.services.build({ fallback: parent });
  }

  register<T>(
    token: Token<T>,
    provider: Provider<T> | ClassConstructor<T>,
    options: RegistrationOptions = {},
  ): this {
    const lifetime = lifecycleToLifetime(options.lifecycle);
    const binding = {
      lifetime,
      multiple: options.multiple,
    };

    if (typeof provider === "function") {
      this.services.addBinding(
        token,
        annotatedClassFactory(provider as ClassConstructor<T>),
        binding,
      );
    } else if ("useValue" in provider) {
      this.services.useValue(token, provider.useValue, {
        multiple: options.multiple,
      });
    } else if ("useFactory" in provider) {
      this.services.addBinding(
        token,
        (resolver) => provider.useFactory(this.contextual(resolver)),
        binding,
      );
    } else if ("useToken" in provider) {
      this.services.addBinding(
        token,
        (resolver) => resolver.resolve(provider.useToken),
        { ...binding, dependencies: [provider.useToken] },
      );
    } else {
      this.services.addBinding(
        token,
        annotatedClassFactory(provider.useClass as ClassConstructor<T>),
        binding,
      );
    }
    return this;
  }

  registerSingleton<T>(from: Token<T>, to?: Token<T>): this {
    if (typeof from !== "function" && to === undefined) {
      throw new TypeError(
        'Cannot register a non-class token as a singleton without a "to" token.',
      );
    }
    const target = (to ?? from) as ClassConstructor<T> | Token<T>;
    if (typeof target === "function") {
      this.services.addBinding(
        from,
        annotatedClassFactory(target as ClassConstructor<T>),
        { lifetime: ServiceLifetime.Singleton },
      );
    } else {
      this.services.addBinding(from, (resolver) => resolver.resolve(target), {
        lifetime: ServiceLifetime.Singleton,
        dependencies: [target],
      });
    }
    return this;
  }

  registerType<T>(from: Token<T>, to: Token<T>): this {
    if (typeof to === "function") {
      return this.register(from, {
        useClass: to as ClassConstructor<T>,
      });
    }
    return this.register(from, { useToken: to });
  }

  registerInstance<T>(token: Token<T>, instance: T): this {
    this.services.useValue(token, instance);
    return this;
  }

  resolve<T>(token: TokenLike<T>): T {
    if (typeof token === "function" && !this.isRegistered(token, true)) {
      this.register(token as ClassConstructor<T>, token as ClassConstructor<T>);
    }
    return this.provider.resolve(token);
  }

  async resolveAsync<T>(token: TokenLike<T>): Promise<T> {
    if (typeof token === "function" && !this.isRegistered(token, true)) {
      this.register(token as ClassConstructor<T>, token as ClassConstructor<T>);
    }
    return this.provider.resolveAsync(token);
  }

  resolveAll<T>(token: Token<T>): T[] {
    if (typeof token === "function" && !this.isRegistered(token, true)) {
      this.register(token as ClassConstructor<T>, token as ClassConstructor<T>);
    }
    return this.provider.resolveAll(token);
  }

  resolveAllAsync<T>(token: Token<T>): Promise<T[]> {
    if (typeof token === "function" && !this.isRegistered(token, true)) {
      this.register(token as ClassConstructor<T>, token as ClassConstructor<T>);
    }
    return this.provider.resolveAllAsync(token);
  }

  tryResolve<T>(token: TokenLike<T>): T | undefined {
    return this.provider.tryResolve(token);
  }

  tryResolveMissing<T>(token: TokenLike<T>): T | undefined {
    return this.provider.tryResolveMissing(token);
  }

  tryResolveAsync<T>(token: TokenLike<T>): Promise<T | undefined> {
    return this.provider.tryResolveAsync(token);
  }

  tryResolveMissingAsync<T>(token: TokenLike<T>): Promise<T | undefined> {
    return this.provider.tryResolveMissingAsync(token);
  }

  resolveMap<T>(token: Token<T>): Record<string | number | symbol, T> {
    return this.provider.resolveMap(token);
  }

  resolveMapAsync<T>(
    token: Token<T>,
  ): Promise<Record<string | number | symbol, T>> {
    return this.provider.resolveMapAsync(token);
  }

  getRequiredService<T>(token: TokenLike<T>): T {
    return this.resolve(token);
  }

  getService<T>(token: TokenLike<T>): T | undefined {
    return this.provider.getService(token);
  }

  getServices<T>(token: Token<T>): T[] {
    return this.resolveAll(token);
  }

  getServicesAsync<T>(token: Token<T>): Promise<T[]> {
    return this.resolveAllAsync(token);
  }

  isRegistered<T>(token: Token<T>, recursive = false): boolean {
    return this.provider.isRegistered(token, recursive);
  }

  reset(): void {
    this.services.reset();
    this.provider.reset();
  }

  clearInstances(): void {
    this.provider.clearInstances();
  }

  createChildContainer(): DependencyContainer {
    return new Container(this);
  }

  beforeResolution<T>(
    token: Token<T>,
    callback: PreResolutionInterceptorCallback<T>,
    options?: InterceptorOptions,
  ): void {
    this.provider.beforeResolution(token, callback, options);
  }

  afterResolution<T>(
    token: Token<T>,
    callback: PostResolutionInterceptorCallback<T>,
    options?: InterceptorOptions,
  ): void {
    this.provider.afterResolution(token, callback, options);
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }

  private contextual(resolver: ServiceResolver): DependencyContainer {
    const context = Object.create(this) as DependencyContainer & {
      readonly __containerIdentity: Container;
    };
    Object.defineProperty(context, "__containerIdentity", {
      value: this,
      enumerable: false,
    });
    context.resolve = resolver.resolve.bind(resolver);
    context.resolveAsync = resolver.resolveAsync.bind(resolver);
    context.resolveAll = resolver.resolveAll.bind(resolver);
    context.resolveAllAsync = resolver.resolveAllAsync.bind(resolver);
    context.resolveMap = resolver.resolveMap.bind(resolver);
    context.resolveMapAsync = resolver.resolveMapAsync.bind(resolver);
    context.tryResolve = resolver.tryResolve.bind(resolver);
    context.tryResolveMissing = resolver.tryResolveMissing.bind(resolver);
    context.tryResolveAsync = resolver.tryResolveAsync.bind(resolver);
    context.tryResolveMissingAsync =
      resolver.tryResolveMissingAsync.bind(resolver);
    context.getRequiredService = resolver.getRequiredService.bind(resolver);
    context.getService = resolver.getService.bind(resolver);
    context.getServices = resolver.getServices.bind(resolver);
    context.getServicesAsync = resolver.getServicesAsync.bind(resolver);
    context.isRegistered = (token, recursive = true) =>
      this.isRegistered(token, recursive);
    return context;
  }
}

export const container: DependencyContainer = new Container();

export function singleton(): <TClass extends ClassConstructor<any>>(
  target: TClass,
) => TClass;
export function singleton<TClass extends ClassConstructor<any>>(
  target: TClass,
): TClass;
export function singleton<TClass extends ClassConstructor<any>>(
  target?: TClass,
): TClass | (<T extends ClassConstructor<any>>(target: T) => T) {
  const decorate = <T extends ClassConstructor<any>>(klass: T): T => {
    container.registerSingleton(klass);
    return klass;
  };
  return target ? decorate(target) : decorate;
}

export function scoped(
  lifecycle: Lifecycle = Lifecycle.Transient,
): <TClass extends ClassConstructor<any>>(target: TClass) => TClass {
  return <TClass extends ClassConstructor<any>>(target: TClass): TClass => {
    container.register(target, target, { lifecycle });
    return target;
  };
}

type AnyClass = new (...args: any[]) => any;

export function autoInjectable(): <TClass extends AnyClass>(
  target: TClass,
) => new (...args: any[]) => InstanceType<TClass> {
  return <TClass extends AnyClass>(
    target: TClass,
  ): new (...args: any[]) => InstanceType<TClass> => {
    const injected = class extends target {
      constructor(...args: any[]) {
        super(
          ...(args.length
            ? args
            : resolveInjectionParameters(container, target)),
        );
      }
    };
    return injected as new (...args: any[]) => InstanceType<TClass>;
  };
}

export function registry(
  registrations: Array<
    Provider<unknown> & { token: Token; options?: RegistrationOptions }
  > = [],
): <TClass extends ClassConstructor<any>>(target: TClass) => TClass {
  return <TClass extends ClassConstructor<any>>(target: TClass): TClass => {
    for (const registration of registrations) {
      const { token, options, ...provider } = registration;
      container.register(
        token,
        provider as unknown as ClassConstructor<unknown>,
        options,
      );
    }
    return target;
  };
}

export function instanceCachingFactory<T>(
  factory: (container: DependencyContainer) => T,
): (container: DependencyContainer) => T {
  let initialized = false;
  let value!: T;
  return (current) => {
    if (!initialized) {
      value = factory(current);
      initialized = true;
    }
    return value;
  };
}

export function instancePerContainerCachingFactory<T>(
  factory: (container: DependencyContainer) => T,
): (container: DependencyContainer) => T {
  const cache = new WeakMap<object, { value: T }>();
  return (current) => {
    const key =
      (current as DependencyContainer & { __containerIdentity?: object })
        .__containerIdentity ?? current;
    const existing = cache.get(key);
    if (existing) return existing.value;
    const value = factory(current);
    cache.set(key, { value });
    return value;
  };
}

export function predicateAwareClassFactory<T>(
  predicate: (container: DependencyContainer) => boolean,
  trueConstructor: ClassConstructor<T>,
  falseConstructor: ClassConstructor<T>,
  useCaching = true,
): (container: DependencyContainer) => T {
  let initialized = false;
  let previousPredicate = false;
  let value!: T;
  return (current) => {
    const result = predicate(current);
    if (!useCaching || !initialized || previousPredicate !== result) {
      previousPredicate = result;
      initialized = true;
      value = current.resolve(result ? trueConstructor : falseConstructor);
    }
    return value;
  };
}

function lifecycleToLifetime(lifecycle?: Lifecycle): ServiceLifetime {
  switch (lifecycle) {
    case Lifecycle.Singleton:
      return ServiceLifetime.Singleton;
    case Lifecycle.ResolutionScoped:
      return ServiceLifetime.ResolutionScoped;
    case Lifecycle.ContainerScoped:
      return ServiceLifetime.ContainerScoped;
    case Lifecycle.Transient:
    default:
      return ServiceLifetime.Transient;
  }
}
