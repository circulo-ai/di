import type { OptionalToken, Token } from "./types";

export function createToken<T>(name?: string): Token<T> {
  return Symbol(name ?? "token") as Token<T>;
}

export function optional<T>(token: Token<T>): OptionalToken<T> {
  return { __optional: true, token };
}
