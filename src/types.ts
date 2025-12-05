import type { ServiceLifetime } from "./lifetime";

export type Token<T = unknown> =
  | string
  | symbol
  | (abstract new (...args: any[]) => T);

export type OptionalToken<T = unknown> = {
  __optional: true;
  token: Token<T>;
};

export type TokenLike<T = unknown> = Token<T> | OptionalToken<T>;
export type ServiceKey = string | number | symbol;

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
  resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T>;
  tryResolveAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined>;
}

// Runtime marker to keep coverage tooling happy; purely informational.
export const TYPES_MODULE_LOADED = true;

export type ServiceFactoryResult<T> = T | Promise<T>;
export type ServiceFactory<T> = (resolver: ServiceResolver) => ServiceFactoryResult<T>;

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
