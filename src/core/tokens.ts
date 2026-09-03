import type { InjectionToken, OptionalToken, Token } from "./types.js";

export function createToken<T>(name?: string): InjectionToken<T> {
  return Symbol(name ?? "token") as InjectionToken<T>;
}

export function optional<T>(token: InjectionToken<T>): OptionalToken<T>;
export function optional<T>(token: Token<T>): OptionalToken<T>;
export function optional<T>(token: Token<T>): OptionalToken<T> {
  if (
    typeof token !== "string" &&
    typeof token !== "symbol" &&
    typeof token !== "function" &&
    !(
      token &&
      typeof token === "object" &&
      (token as { __delayed?: unknown }).__delayed === true
    )
  ) {
    throw new TypeError("An optional token must wrap a valid service token.");
  }

  const optionalToken = Object.create(null) as OptionalToken<T>;
  Object.defineProperties(optionalToken, {
    __optional: {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    token: {
      value: token,
      enumerable: true,
      writable: false,
      configurable: false,
    },
  });
  return Object.freeze(optionalToken);
}
