import { ServiceLifetime } from "./lifetime";
import type {
  DisposeFn,
  ServiceDescriptor,
  ServiceFactory,
  ServiceKey,
  Token,
  TraceEvent,
} from "./types";
import { ServiceProvider } from "./service-provider";

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

  addSingleton<T>(
    token: Token<T>,
    factoryOrInstance: ServiceFactory<T> | T,
    options?: {
      key?: ServiceKey;
      multiple?: boolean;
      globalKey?: string;
      disposePriority?: number;
      source?: string;
    },
  ): this {
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
      },
      options,
    );
  }

  addGlobalSingleton<T>(
    token: Token<T>,
    factoryOrInstance: ServiceFactory<T> | T,
    options?: {
      key?: ServiceKey;
      multiple?: boolean;
      globalKey?: string;
      disposePriority?: number;
      source?: string;
    },
  ): this {
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
      },
      options,
    );
  }

  addScoped<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: { key?: ServiceKey; multiple?: boolean; disposePriority?: number; source?: string },
  ): this {
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
      },
      options,
    );
  }

  addTransient<T>(
    token: Token<T>,
    factory: ServiceFactory<T>,
    options?: { key?: ServiceKey; multiple?: boolean; disposePriority?: number; source?: string },
  ): this {
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
      },
      options,
    );
  }

  build(): ServiceProvider {
    return new ServiceProvider(
      [...this.descriptors.entries()].flatMap(([_, descriptors]) => descriptors),
      { trace: this.defaults.trace },
    );
  }

  private wrapFactory<T>(
    factoryOrInstance: ServiceFactory<T> | T | { value: T; dispose?: DisposeFn; close?: DisposeFn; destroy?: DisposeFn },
  ): ServiceFactory<T> {
    if (typeof factoryOrInstance === "function") {
      return factoryOrInstance as ServiceFactory<T>;
    }
    if (
      factoryOrInstance &&
      typeof factoryOrInstance === "object" &&
      "value" in factoryOrInstance
    ) {
      const disposer =
        (factoryOrInstance as any).dispose ||
        (factoryOrInstance as any).close ||
        (factoryOrInstance as any).destroy;
      const value = (factoryOrInstance as any).value as T;
      const fn = () => value;
      (fn as any).__customDispose = disposer as DisposeFn | undefined;
      return fn;
    }
    return () => factoryOrInstance as T;
  }

  private addDescriptor<T>(
    token: Token<T>,
    descriptor: ServiceDescriptor<T>,
    options?: { multiple?: boolean },
  ): this {
    const existing = this.descriptors.get(token) ?? [];
    const multiple = options?.multiple ?? this.defaults.defaultMultiple ?? false;
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
