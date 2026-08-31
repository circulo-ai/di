import { createBinder, scopeToLifetime } from "../binding/binding.js";
import type { ServiceModule } from "../binding/module.js";
import { annotatedClassFactory, getInjectionMetadata } from "./annotations.js";
import { ServiceLifetime } from "./lifetime.js";
import { ServiceProvider } from "./service-provider.js";
import type {
  BindingOptions,
  ClassConstructor,
  DependencyArray,
  DependencyObject,
  DisposeFn,
  ServiceDescriptor,
  ServiceFactory,
  ServiceRegistrationOptions,
  Token,
  TraceEvent,
  ValueProvider,
} from "./types.js";

const VALUE_PROVIDER_MARKER = Symbol("@circulo-ai/di/value-provider");

export class ServiceCollection {
  constructor(
    private readonly defaults: {
      allowOverwrite?: boolean;
      defaultMultiple?: boolean;
      captureStack?: boolean;
      trace?: (event: TraceEvent) => void;
    } = {},
  ) {}

  private readonly descriptors = new Map<Token, ServiceDescriptor[]>();

  bind<T>(token: Token<T>) {
    return createBinder(
      <U>(
        innerToken: Token<U>,
        factory: ServiceFactory<U>,
        options?: BindingOptions,
      ) => this.addBinding(innerToken, factory, options),
    )(token);
  }

  addModule(module: ServiceModule): this {
    module.applyTo(this);
    return this;
  }

  addSingleton<T>(token: new (...args: any[]) => T): this;
  addSingleton<T>(
    token: Token<T>,
    factoryOrInstance: ServiceFactory<T> | T | ValueProvider<T>,
    options?: ServiceRegistrationOptions,
  ): this;
  addSingleton<T>(
    token: Token<T>,
    factoryOrInstance?: ServiceFactory<T> | T | ValueProvider<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    if (arguments.length === 1) {
      factoryOrInstance = this.classFactoryFor(token);
    }
    const factory = this.wrapFactory(factoryOrInstance);
    return this.addDescriptor(
      token,
      {
        id: Symbol(),
        token,
        lifetime: ServiceLifetime.Singleton,
        factory,
        key: options?.key,
        globalKey: options?.globalKey,
        disposePriority: options?.disposePriority ?? 0,
        registeredAt: new Date(),
        source: options?.source ?? this.captureSource(),
        dependencies: options?.dependencies ?? this.classDependencies(token),
        disposal:
          options?.disposal ?? defaultDisposal(ServiceLifetime.Singleton),
      },
      options,
    );
  }

  addGlobalSingleton<T>(token: new (...args: any[]) => T): this;
  addGlobalSingleton<T>(
    token: Token<T>,
    factoryOrInstance: ServiceFactory<T> | T | ValueProvider<T>,
    options?: ServiceRegistrationOptions,
  ): this;
  addGlobalSingleton<T>(
    token: Token<T>,
    factoryOrInstance?: ServiceFactory<T> | T | ValueProvider<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    if (arguments.length === 1) {
      factoryOrInstance = this.classFactoryFor(token);
    }
    const factory = this.wrapFactory(factoryOrInstance);
    return this.addDescriptor(
      token,
      {
        id: Symbol(),
        token,
        lifetime: ServiceLifetime.GlobalSingleton,
        factory,
        key: options?.key,
        globalKey: options?.globalKey,
        disposePriority: options?.disposePriority ?? 0,
        registeredAt: new Date(),
        source: options?.source ?? this.captureSource(),
        dependencies: options?.dependencies ?? this.classDependencies(token),
        disposal:
          options?.disposal ?? defaultDisposal(ServiceLifetime.GlobalSingleton),
      },
      options,
    );
  }

  addScoped<T>(token: new (...args: any[]) => T): this;
  addScoped<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: ServiceRegistrationOptions,
  ): this;
  addScoped<T>(
    token: Token<T>,
    factory?: ServiceFactory<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    if (arguments.length === 1) factory = this.classFactoryFor(token);
    if (!factory) throw new TypeError("A scoped service factory is required.");
    return this.addDescriptor(
      token,
      {
        id: Symbol(),
        token,
        lifetime: ServiceLifetime.Scoped,
        factory,
        key: options?.key,
        disposePriority: options?.disposePriority ?? 0,
        registeredAt: new Date(),
        source: options?.source ?? this.captureSource(),
        dependencies: options?.dependencies ?? this.classDependencies(token),
        disposal: options?.disposal ?? defaultDisposal(ServiceLifetime.Scoped),
      },
      options,
    );
  }

  addTransient<T>(token: new (...args: any[]) => T): this;
  addTransient<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: ServiceRegistrationOptions,
  ): this;
  addTransient<T>(
    token: Token<T>,
    factory?: ServiceFactory<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    if (arguments.length === 1) factory = this.classFactoryFor(token);
    if (!factory) {
      throw new TypeError("A transient service factory is required.");
    }
    return this.addDescriptor(
      token,
      {
        id: Symbol(),
        token,
        lifetime: ServiceLifetime.Transient,
        factory,
        key: options?.key,
        disposePriority: options?.disposePriority ?? 0,
        registeredAt: new Date(),
        source: options?.source ?? this.captureSource(),
        dependencies: options?.dependencies ?? this.classDependencies(token),
        disposal:
          options?.disposal ?? defaultDisposal(ServiceLifetime.Transient),
      },
      options,
    );
  }

  build(): ServiceProvider {
    return new ServiceProvider(
      [...this.descriptors.entries()].flatMap(
        ([_, descriptors]) => descriptors,
      ),
      { trace: this.defaults.trace },
    );
  }

  useValue<T>(
    token: Token<T>,
    value: T,
    options?: ServiceRegistrationOptions,
  ): this {
    const valueProvider = Object.create(null) as ValueProvider<T> & {
      [VALUE_PROVIDER_MARKER]: true;
    };
    Object.defineProperties(valueProvider, {
      value: {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      },
      [VALUE_PROVIDER_MARKER]: {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
    return this.addSingleton(token, valueProvider, options);
  }

  useFactory<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    return this.addSingleton(token, factory, options);
  }

  useClass<T>(
    token: Token<T>,
    Klass: ClassConstructor<T>,
    dependencies?: DependencyArray | DependencyObject,
    options?: ServiceRegistrationOptions,
  ): this {
    this.bind(token).toClass(Klass, dependencies, options);
    return this;
  }

  useExisting<T>(
    token: Token<T>,
    existing: Token<T>,
    options?: ServiceRegistrationOptions,
  ): this {
    return this.addSingleton(token, (resolver) => resolver.resolve(existing), {
      ...options,
      dependencies: options?.dependencies ?? [existing],
    });
  }

  /**
   * .NET-style provider builder with an optional registration validation gate.
   */
  buildServiceProvider(options?: {
    validateOnBuild?: boolean;
    requireKeysForMultiple?: boolean;
  }): ServiceProvider {
    const provider = this.build();
    if (options?.validateOnBuild) {
      provider.validateGraph({
        throwOnError: true,
        requireKeysForMultiple: options.requireKeysForMultiple,
      });
    }
    return provider;
  }

  private wrapFactory<T>(
    factoryOrInstance: ServiceFactory<T> | T | ValueProvider<T>,
  ): ServiceFactory<T> {
    if (typeof factoryOrInstance === "function") {
      return factoryOrInstance as ServiceFactory<T>;
    }
    if (isValueProvider(factoryOrInstance)) {
      const provider = factoryOrInstance as ValueProvider<T>;
      const disposer = getValueProviderDisposer(provider);
      const value = provider.value;
      const fn = () => value;
      (fn as any).__customDispose = disposer as DisposeFn | undefined;
      return fn;
    }
    return () => factoryOrInstance as T;
  }

  private classFactoryFor<T>(token: Token<T>): ServiceFactory<T> {
    if (typeof token !== "function") {
      throw new TypeError(
        "A service factory or instance is required for non-class tokens.",
      );
    }
    return annotatedClassFactory(token as ClassConstructor<T>);
  }

  private classDependencies(token: Token): DependencyArray | undefined {
    if (typeof token !== "function") return undefined;
    return dependencyArray(getInjectionMetadata(token));
  }

  private addDescriptor<T>(
    token: Token<T>,
    descriptor: ServiceDescriptor<T>,
    options?: { multiple?: boolean },
  ): this {
    const existing = this.descriptors.get(token) ?? [];
    const multiple =
      options?.multiple ?? this.defaults.defaultMultiple ?? false;
    if (!multiple && !this.defaults.allowOverwrite && existing.length > 0) {
      throw new Error(
        `Service already registered for token ${String(token)}. Set allowOverwrite to true or use multiple registrations.`,
      );
    }
    // propagate custom disposer if factory carried one
    const factoryDispose = (descriptor.factory as any).__customDispose as
      | DisposeFn
      | undefined;
    if (factoryDispose) {
      descriptor.customDispose = factoryDispose;
    }
    if (multiple) {
      existing.push(descriptor);
      this.descriptors.set(token, existing);
    } else {
      this.descriptors.set(token, [descriptor]);
    }
    return this;
  }

  /**
   * Internal: used by binder/module helpers.
   */
  addBinding<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: BindingOptions,
  ): this {
    const lifetime =
      options?.lifetime ??
      scopeToLifetime(options?.scope) ??
      ServiceLifetime.Singleton;
    const registration = {
      key: options?.key,
      multiple: options?.multiple,
      disposePriority: options?.disposePriority,
      globalKey: options?.globalKey,
      source: options?.source,
      dependencies: options?.dependencies,
      disposal: options?.disposal,
    };
    switch (lifetime) {
      case ServiceLifetime.GlobalSingleton:
        return this.addGlobalSingleton(token, factory, registration);
      case ServiceLifetime.Scoped:
        return this.addScoped(token, factory, registration);
      case ServiceLifetime.Transient:
        return this.addTransient(token, factory, registration);
      case ServiceLifetime.Singleton:
      default:
        return this.addSingleton(token, factory, registration);
    }
  }

  private captureSource(): string | undefined {
    if (!this.defaults.captureStack) return undefined;
    const err = new Error();
    return err.stack;
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get count(): number {
    let total = 0;
    for (const list of this.descriptors.values()) total += list.length;
    return total;
  }

  /**
   * Exposed for testing/introspection; not part of public surface.
   */
  /* istanbul ignore next */
  get tokens(): Token[] {
    return [...this.descriptors.keys()];
  }
}

function isValueProvider<T>(value: unknown): value is ValueProvider<T> {
  if (!value || typeof value !== "object" || !("value" in value)) {
    return false;
  }
  if (VALUE_PROVIDER_MARKER in value) return true;
  if (["dispose", "close", "destroy"].some(
    (name) =>
      name in value &&
      typeof (value as Record<string, unknown>)[name] === "function",
  )) {
    return true;
  }
  return isDisposableLike((value as ValueProvider<unknown>).value);
}

function isDisposableLike(value: unknown): boolean {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    ["dispose", "close", "destroy"].some(
      (name) => typeof candidate[name] === "function",
    ) ||
    typeof candidate[(Symbol as any).asyncDispose] === "function" ||
    typeof candidate[(Symbol as any).dispose] === "function"
  );
}

function getValueProviderDisposer<T>(
  provider: ValueProvider<T>,
): DisposeFn | undefined {
  for (const name of ["dispose", "close", "destroy"] as const) {
    const candidate = provider[name];
    if (candidate !== undefined && typeof candidate !== "function") {
      throw new TypeError(`Value provider property ${name} must be a function.`);
    }
    if (candidate) return candidate;
  }
  return undefined;
}

function dependencyArray(
  dependencies: DependencyArray | DependencyObject | undefined,
): DependencyArray | undefined {
  if (!dependencies) return undefined;
  return Array.isArray(dependencies)
    ? dependencies
    : Object.values(dependencies);
}

function defaultDisposal(lifetime: ServiceLifetime) {
  switch (lifetime) {
    case ServiceLifetime.Singleton:
      return "provider" as const;
    case ServiceLifetime.Scoped:
      return "scope" as const;
    case ServiceLifetime.GlobalSingleton:
      return "global" as const;
    default:
      return "none" as const;
  }
}
