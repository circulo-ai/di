import type {
  OptionalToken,
  ServiceResolver,
  Token,
  TokenLike,
} from "../core/types";

export type TokenTree = {
  [key: string]: TokenTree | TokenLike;
};

type ResolveToken<T> = T extends Token<infer R>
  ? R
  : T extends { __optional: true; token: Token<infer R> }
    ? R | undefined
    : never;

export type ResolvedServices<T extends TokenTree> = {
  [K in keyof T]: T[K] extends TokenLike
    ? ResolveToken<T[K]>
    : T[K] extends TokenTree
      ? ResolvedServices<T[K]>
      : never;
};

export type ServiceLocatorOptions = {
  /**
   * Cache resolved services by property name. Defaults to false
   * to preserve transient service semantics.
   */
  cache?: boolean;
  /**
   * Alias for cache; kept for clarity.
   */
  memoize?: boolean;
  /**
   * Throw if a token is missing instead of returning undefined.
   */
  strict?: boolean;
};

function isOptionalToken(value: unknown): value is OptionalToken {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.__optional !== true) return false;
  const token = record.token;
  return (
    typeof token === "string" ||
    typeof token === "symbol" ||
    typeof token === "function"
  );
}

function isToken(value: unknown): value is TokenLike {
  if (
    typeof value === "string" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return true;
  }

  return isOptionalToken(value);
}

export function createServiceLocator<T extends TokenTree>(
  resolver: ServiceResolver,
  tokens: T,
  options?: ServiceLocatorOptions,
): ResolvedServices<T> {
  const cache = options?.memoize ?? options?.cache ?? false;
  const strict = options?.strict ?? false;
  const proxies = new WeakMap<object, unknown>();

  const missingTokenError = (name: string) => {
    return new Error(`Service token not registered for "${name}".`);
  };

  const build = <TNode extends TokenTree>(
    tree: TNode,
  ): ResolvedServices<TNode> => {
    const cachedProxy = proxies.get(tree as object);
    if (cachedProxy) return cachedProxy as ResolvedServices<TNode>;

    const resolved = cache ? new Map<PropertyKey, unknown>() : null;
    const nested = new Map<PropertyKey, unknown>();

    const proxy = new Proxy({} as ResolvedServices<TNode>, {
      get(_target, property: string | symbol) {
        if (typeof property !== "string") return undefined;
        if (!Object.prototype.hasOwnProperty.call(tree, property)) {
          if (strict) throw missingTokenError(property);
          return undefined;
        }

        if (resolved?.has(property)) {
          return resolved.get(property) as ResolvedServices<TNode>[keyof TNode];
        }

        if (nested.has(property)) {
          return nested.get(property) as ResolvedServices<TNode>[keyof TNode];
        }

        const value = (tree as Record<string, unknown>)[property];
        if (value === undefined) {
          throw missingTokenError(property);
        }

        if (isToken(value)) {
          const resolvedValue = resolver.resolve(value as TokenLike);
          if (resolved) {
            resolved.set(property, resolvedValue);
          }
          return resolvedValue as ResolvedServices<TNode>[keyof TNode];
        }

        if (value && typeof value === "object") {
          const locator = build(value as TokenTree);
          nested.set(property, locator);
          return locator as ResolvedServices<TNode>[keyof TNode];
        }

        return value as ResolvedServices<TNode>[keyof TNode];
      },
    });

    proxies.set(tree as object, proxy);
    return proxy;
  };

  return build(tokens);
}
