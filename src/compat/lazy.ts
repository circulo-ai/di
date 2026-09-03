import type {
  AbstractClassConstructor,
  DelayedToken,
  Token,
} from "../core/types.js";

const REFLECT_METHODS = [
  "get",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "defineProperty",
  "has",
  "set",
  "deleteProperty",
  "apply",
  "construct",
  "ownKeys",
] as const;

/** A lazy constructor token for circular dependencies. */
export class DelayedConstructor<T = unknown> implements DelayedToken<T> {
  readonly __delayed = true as const;

  constructor(private readonly wrap: () => AbstractClassConstructor<T>) {
    if (typeof wrap !== "function") {
      throw new TypeError("delay() requires a constructor callback.");
    }
  }

  getConstructor(): AbstractClassConstructor<T> {
    const constructor = this.wrap();
    if (typeof constructor !== "function") {
      throw new TypeError("delay() callback must return a constructor.");
    }
    return constructor;
  }

  createProxy(resolve: (constructor: AbstractClassConstructor<T>) => T): T {
    let initialized = false;
    let value!: T;
    const getValue = () => {
      if (!initialized) {
        value = resolve(this.getConstructor());
        initialized = true;
      }
      return value;
    };

    const handler: ProxyHandler<object> = {};
    for (const method of REFLECT_METHODS) {
      handler[method] = (...args: unknown[]) => {
        args[0] = getValue();
        return (Reflect as any)[method](...args);
      };
    }
    return new Proxy({}, handler) as T;
  }
}

export function delay<T>(
  wrappedConstructor: () => AbstractClassConstructor<T>,
): Token<T> {
  return new DelayedConstructor(wrappedConstructor) as Token<T>;
}
