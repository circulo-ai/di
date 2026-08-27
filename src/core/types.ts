import type { ServiceLifetime } from "./lifetime.js";

declare const INJECTION_TOKEN_TYPE: unique symbol;
declare const OPTIONAL_TOKEN_TYPE: unique symbol;

/** A runtime class token with a statically known instance type. */
export type ClassConstructor<
  T,
  TArgs extends readonly unknown[] = any[],
> = new (...args: TArgs) => T;

export type AbstractClassConstructor<
  T,
  TArgs extends readonly unknown[] = any[],
> = abstract new (...args: TArgs) => T;

/** A runtime symbol carrying its service type for TypeScript inference. */
export type InjectionToken<T> = symbol & {
  readonly [INJECTION_TOKEN_TYPE]?: T;
};

export type Token<T = unknown> =
  | string
  | symbol
  | InjectionToken<T>
  | AbstractClassConstructor<T>;

export type OptionalToken<T = unknown> = {
  __optional: true;
  token: Token<T>;
  readonly [OPTIONAL_TOKEN_TYPE]?: T;
};

export type TokenLike<T = unknown> = Token<T> | OptionalToken<T>;
export type ServiceKey = string | number | symbol;

export type BindingScope =
  | "singleton"
  | "global"
  | "globalSingleton"
  | "scoped"
  | "transient";

export type BindingOptions = {
  /**
   * Scope/lifetime of the binding. Defaults to "singleton".
   */
  scope?: BindingScope;
  /**
   * Explicit lifetime; overrides `scope` when provided.
   */
  lifetime?: ServiceLifetime;
  key?: ServiceKey;
  multiple?: boolean;
  disposePriority?: number;
  globalKey?: string;
  source?: string;
  /**
   * If true, dependency resolution inside binder helpers will use
   * `resolveAsync`/`Promise.all` and return a promise from the factory.
   */
  async?: boolean;
  /** Explicit dependencies used for startup graph validation. */
  dependencies?: DependencyArray;
  /** Controls ownership of disposable instances. */
  disposal?: DisposalPolicy;
};

export type DisposalPolicy = "none" | "scope" | "provider" | "global";

export type DependencyArray = readonly TokenLike[];
export type DependencyObject = Readonly<Record<string, TokenLike>>;
export type ServiceRegistrationOptions = {
  key?: ServiceKey;
  multiple?: boolean;
  disposePriority?: number;
  globalKey?: string;
  source?: string;
  dependencies?: DependencyArray;
  disposal?: DisposalPolicy;
};

export type DiagnosticLevel = "warning" | "error";
export type Diagnostic = {
  level: DiagnosticLevel;
  message: string;
  token?: Token;
  key?: ServiceKey;
  path?: Token[];
};

export interface ServiceDescriptor<T = unknown> {
  id: symbol;
  token: Token<T>;
  lifetime: ServiceLifetime;
  factory: ServiceFactory<T>;
  key?: ServiceKey;
  globalKey?: string;
  disposePriority: number;
  registeredAt: Date;
  source?: string;
  customDispose?: DisposeFn;
  dependencies?: DependencyArray;
  /** Optional for backwards compatibility with manually-created descriptors. */
  disposal?: DisposalPolicy;
}

export interface ServiceResolver {
  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T;
  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined;
  /** Returns undefined only when the registration is missing. Other failures propagate. */
  tryResolveMissing<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined;
  resolveAll<T>(token: Token<T>): T[];
  resolveAllAsync<T>(token: Token<T>): Promise<T[]>;
  resolveMap<T>(token: Token<T>): Record<ServiceKey, T>;
  resolveMapAsync<T>(token: Token<T>): Promise<Record<ServiceKey, T>>;
  /** .NET-style alias for `resolve`. */
  getRequiredService<T>(token: TokenLike<T>, key?: ServiceKey): T;
  /** Return an unregistered service as undefined; resolution failures still throw. */
  getService<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined;
  /** .NET-style alias for `resolveAll`. */
  getServices<T>(token: Token<T>): T[];
  /** Async alias for `resolveAllAsync`. */
  getServicesAsync<T>(token: Token<T>): Promise<T[]>;
  resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T>;
  tryResolveAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined>;
  tryResolveMissingAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined>;
}

// Runtime marker to keep coverage tooling happy; purely informational.
export const TYPES_MODULE_LOADED = true;

export type ServiceFactoryResult<T> = T | Promise<T>;
export type ServiceFactory<T> = (
  resolver: ServiceResolver,
) => ServiceFactoryResult<T>;

export type MaybeDisposable =
  | { dispose?: () => void | Promise<void> }
  | { close?: () => void | Promise<void> }
  | { destroy?: () => void | Promise<void> };

export type DisposeFn = () => unknown | Promise<unknown>;

export type ValueProvider<T> = {
  value: T;
  dispose?: DisposeFn;
  close?: DisposeFn;
  destroy?: DisposeFn;
};

export type TraceEvent = {
  token: Token;
  key?: ServiceKey;
  lifetime: ServiceLifetime;
  path: string[];
  async: boolean;
};
