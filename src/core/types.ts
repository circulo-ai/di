import type { ServiceLifetime } from "./lifetime.js";

declare const INJECTION_TOKEN_TYPE: unique symbol;
declare const OPTIONAL_TOKEN_TYPE: unique symbol;

/** A runtime symbol carrying its service type for TypeScript inference. */
export type InjectionToken<T> = symbol & {
  readonly [INJECTION_TOKEN_TYPE]?: T;
};

export type Token<T = unknown> =
  | string
  | symbol
  | InjectionToken<T>
  | (abstract new (...args: any[]) => T);

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
};

export type DependencyArray = readonly TokenLike[];
export type DependencyObject = Readonly<Record<string, TokenLike>>;

export type DiagnosticLevel = "warning" | "error";
export type Diagnostic = {
  level: DiagnosticLevel;
  message: string;
  token?: Token;
  key?: ServiceKey;
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
}

export interface ServiceResolver {
  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T;
  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined;
  resolveAll<T>(token: Token<T>): T[];
  resolveMap<T>(token: Token<T>): Record<ServiceKey, T>;
  /** .NET-style alias for `resolve`. */
  getRequiredService<T>(token: TokenLike<T>, key?: ServiceKey): T;
  /** Return an unregistered service as undefined; resolution failures still throw. */
  getService<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined;
  /** .NET-style alias for `resolveAll`. */
  getServices<T>(token: Token<T>): T[];
  resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T>;
  tryResolveAsync<T>(
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

export type DisposeFn = () => void | Promise<void>;

export type TraceEvent = {
  token: Token;
  key?: ServiceKey;
  lifetime: ServiceLifetime;
  path: string[];
  async: boolean;
};
