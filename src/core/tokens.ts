import type { InjectionToken, OptionalToken, Token } from "./types.js";

export function createToken<T>(name?: string): InjectionToken<T> {
  return Symbol(name ?? "token") as InjectionToken<T>;
}

export function optional<T>(token: InjectionToken<T>): OptionalToken<T>;
export function optional<T>(token: Token<T>): OptionalToken<T>;
export function optional<T>(token: Token<T>): OptionalToken<T> {
  return { __optional: true, token };
}
