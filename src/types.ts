import type { ServiceLifetime } from "./lifetime";

export type Token<T = unknown> = string | symbol | (abstract new (...args: any[]) => T);
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
}

export interface ServiceResolver {
  resolve<T>(token: Token<T>, key?: ServiceKey): T;
  tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined;
  resolveAll<T>(token: Token<T>): T[];
}

// Runtime marker to keep coverage tooling happy; purely informational.
export const TYPES_MODULE_LOADED = true;

export type ServiceFactory<T> = (resolver: ServiceResolver) => T;

export type MaybeDisposable =
  | { dispose?: () => void | Promise<void> }
  | { close?: () => void | Promise<void> }
  | { destroy?: () => void | Promise<void> };
