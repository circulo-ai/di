import { ServiceLifetime } from "./lifetime";
import type {
  Diagnostic,
  DiagnosticLevel,
  DisposeFn,
  MaybeDisposable,
  ServiceDescriptor,
  ServiceKey,
  ServiceResolver,
  Token,
  TokenLike,
  TraceEvent,
} from "./types";
import { ServiceScope } from "./service-scope";
import {
  AsyncFactoryError,
  CircularDependencyError,
  MissingServiceError,
  ScopeResolutionError,
} from "./errors";

type ResolutionFrame = { token: Token; key?: ServiceKey };

const GLOBAL_CACHE_KEY = Symbol.for("@circulo-ai/di:globals");
const GLOBAL_PROMISE_CACHE_KEY = Symbol.for("@circulo-ai/di:globals:promises");

export class ServiceProvider implements ServiceResolver {
  private readonly descriptors: Map<Token, ServiceDescriptor[]>;
  private singletons = new WeakMap<ServiceDescriptor, unknown>();
  private singletonPromises = new WeakMap<ServiceDescriptor, Promise<unknown>>();
  private readonly singletonDescriptors = new Set<ServiceDescriptor>();
  private readonly singletonOrder: ServiceDescriptor[] = [];
  private readonly disposeHandlers: Array<{ fn: DisposeFn; priority: number }> =
    [];
  private readonly globalCache: Map<string, unknown>;
  private readonly globalPromises: Map<string, Promise<unknown>>;

  constructor(
    descriptors: ServiceDescriptor[],
    private readonly options: { trace?: (event: TraceEvent) => void } = {},
  ) {
    const grouped = new Map<Token, ServiceDescriptor[]>();
    descriptors.forEach((d) => {
      const list = grouped.get(d.token) ?? [];
      list.push(d);
      grouped.set(d.token, list);
    });
    this.descriptors = grouped;
    this.globalCache = getGlobalCache();
    this.globalPromises = getGlobalPromiseCache();
  }

  onDispose(handler: DisposeFn): void {
    this.onDisposeWithPriority(handler);
  }

  onDisposeWithPriority(handler: DisposeFn, priority = 0): void {
    this.disposeHandlers.push({ fn: handler, priority });
  }

  async withScope<T>(
    work: (scope: ServiceScope) => Promise<T> | T,
  ): Promise<T> {
    const scope = this.createScope();
    try {
      return await work(scope);
    } finally {
      await scope.dispose();
    }
  }

  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T {
    return this.resolveInternal(token, null, key, [], false) as T;
  }

  async resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T> {
    return (await this.resolveInternal(token, null, key, [], true)) as T;
  }

  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    try {
      return this.resolve(token, key);
    } catch {
      return undefined;
    }
  }

  async tryResolveAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined> {
    try {
      return await this.resolveAsync(token, key);
    } catch {
      return undefined;
    }
  }

  resolveAll<T>(token: Token<T>): T[] {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length) {
      return [];
    }
    return descriptors.map((d) => this.resolveDescriptorSync(d, null, []));
  }

  resolveMap<T>(token: Token<T>): Record<ServiceKey, T> {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length) return {};
    const map: Record<ServiceKey, T> = {} as Record<ServiceKey, T>;
    for (const d of descriptors) {
      if (d.key === undefined) {
        throw new Error(
          `resolveMap requires keyed registrations for token ${tokenLabel(token)}`,
        );
      }
      if (map[d.key] !== undefined) {
        throw new Error(
          `Duplicate key ${keyLabel(d.key)} for token ${tokenLabel(token)}`,
        );
      }
      map[d.key] = this.resolveDescriptorSync(d, null, []);
    }
    return map;
  }

  createScope(): ServiceScope {
    return new ServiceScope(this);
  }

  async dispose(): Promise<void> {
    const sortedHandlers = [...this.disposeHandlers].sort(
      (a, b) => b.priority - a.priority,
    );
    for (const handler of sortedHandlers) {
      await handler.fn();
    }

    const instances: Array<{ descriptor: ServiceDescriptor; instance: unknown }> =
      [];
    for (const descriptor of this.singletonOrder) {
      const value = this.singletons.get(descriptor);
      if (value !== undefined) {
        instances.push({ descriptor, instance: value });
      }
    }
    await disposeMany(
      sortByPriorityAndOrder(instances, (i) => i.descriptor.disposePriority).map(
        (i) => i.instance,
      ),
    );
    await disposeMany(
      sortByPriorityAndOrder(
        this.singletonOrder
          .map((d) => ({ descriptor: d, dispose: d.customDispose }))
          .filter((d) => d.dispose),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.dispose as DisposeFn),
    );
    this.singletons = new WeakMap();
    this.singletonPromises = new WeakMap();
    this.singletonDescriptors.clear();
    this.singletonOrder.length = 0;
  }

  getDescriptor(token: Token, key?: ServiceKey): ServiceDescriptor | undefined {
    return this.pickDescriptor(token, key);
  }

  getDescriptors<T>(token: Token<T>): ServiceDescriptor<T>[] | undefined {
    return this.descriptors.get(token) as ServiceDescriptor<T>[] | undefined;
  }

  has(token: Token): boolean {
    return this.descriptors.has(token);
  }

  validateGraph(options?: {
    throwOnError?: boolean;
    requireKeysForMultiple?: boolean;
    unusedTokens?: Token[];
  }): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const requireKeys = options?.requireKeysForMultiple ?? false;

    for (const [token, descriptors] of this.descriptors.entries()) {
      const keyed = new Map<ServiceKey | undefined, ServiceDescriptor[]>();
      for (const d of descriptors) {
        const key = d.key;
        const list = keyed.get(key) ?? [];
        list.push(d);
        keyed.set(key, list);
      }

      let hasKeyed = false;
      let hasUnkeyed = false;

      for (const [key, group] of keyed.entries()) {
        if (key === undefined) hasUnkeyed = true;
        else hasKeyed = true;
        if (group.length > 1) {
          const message =
            key === undefined
              ? `Multiple registrations for token ${tokenLabel(
                  token,
                )} without a key; resolve() will pick the last registration.`
              : `Multiple registrations for token ${tokenLabel(
                  token,
                )} with key ${keyLabel(key)}; resolution is ambiguous.`;
          const level: DiagnosticLevel = key === undefined ? "warning" : "error";
          diagnostics.push({ level, message, token, key });
        }
      }

      if (descriptors.length > 1 && hasUnkeyed) {
        const level: DiagnosticLevel = requireKeys ? "error" : "warning";
        diagnostics.push({
          level,
          message: `Token ${tokenLabel(
            token,
          )} has multiple registrations without keys; add keys or set requireKeysForMultiple=true to enforce errors.`,
          token,
        });
      }

      if (hasKeyed && hasUnkeyed) {
        diagnostics.push({
          level: "warning",
          message: `Token ${tokenLabel(
            token,
          )} mixes keyed and unkeyed registrations; resolution may be confusing.`,
          token,
        });
      }
    }

    if (options?.unusedTokens?.length) {
      for (const token of options.unusedTokens) {
        if (!this.descriptors.has(token)) {
          diagnostics.push({
            level: "error",
            message: `Unused token ${tokenLabel(
              token,
            )}: no registration found.`,
            token,
          });
        }
      }
    }

    if (options?.throwOnError) {
      const firstError = diagnostics.find((d) => d.level === "error");
      if (firstError) {
        throw new Error(firstError.message);
      }
    }

    return diagnostics;
  }

  resolveFromScope<T>(
    token: TokenLike<T>,
    scope: ServiceScope,
    key?: ServiceKey,
  ): T {
    return this.resolveInternal(token, scope, key, [], false) as T;
  }

  resolveFromScopeAsync<T>(
    token: TokenLike<T>,
    scope: ServiceScope,
    key?: ServiceKey,
  ): Promise<T> {
    return this.resolveInternal(token, scope, key, [], true) as Promise<T>;
  }

  resolveDescriptor<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
  ): T {
    return this.resolveDescriptorSync(descriptor, scope, []);
  }

  async resolveDescriptorAsync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionFrame[],
  ): Promise<T> {
    switch (descriptor.lifetime) {
      case ServiceLifetime.Singleton: {
        const existing = this.singletons.get(descriptor);
        if (existing !== undefined) return existing as T;

        const inflight = this.singletonPromises.get(descriptor);
        if (inflight) return inflight as Promise<T>;

        const promise = this.materializeAsync(descriptor, scope, stack);
        this.singletonPromises.set(descriptor, promise);
        const created = await promise;
        this.singletonPromises.delete(descriptor);
        this.singletons.set(descriptor, created);
        this.singletonDescriptors.add(descriptor);
        this.recordSingletonResolution(descriptor);
        return created;
      }
      case ServiceLifetime.GlobalSingleton: {
        const globalKey = descriptor.globalKey ?? this.globalKeyFor(descriptor);
        if (this.globalCache.has(globalKey)) {
          return this.globalCache.get(globalKey) as T;
        }
        const inflight = this.globalPromises.get(globalKey);
        if (inflight) return inflight as Promise<T>;
        const promise = this.materializeAsync(descriptor, scope, stack);
        this.globalPromises.set(globalKey, promise);
        const created = await promise;
        this.globalPromises.delete(globalKey);
        this.globalCache.set(globalKey, created);
        return created;
      }
      case ServiceLifetime.Scoped: {
        if (!scope) {
          throw new ScopeResolutionError(
            `Cannot resolve scoped service ${tokenLabel(
              descriptor.token,
            )} from root provider. Create a scope first.`,
            descriptor.token,
            descriptor.key,
            stack,
          );
        }
        const cached = scope.getCached(descriptor);
        if (cached !== undefined) return cached as T;

        const pending = scope.getPending(descriptor);
        if (pending) return pending as Promise<T>;

        const promise = this.materializeAsync(descriptor, scope, stack);
        scope.setPending(descriptor, promise);
        const created = await promise;
        scope.setInstance(descriptor, created);
        return created;
      }
      case ServiceLifetime.Transient:
      default: {
        return this.materializeAsync(descriptor, scope, stack);
      }
    }
  }

  private resolveDescriptorSync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionFrame[],
  ): T {
    switch (descriptor.lifetime) {
      case ServiceLifetime.Singleton: {
        const existing = this.singletons.get(descriptor);
        if (existing !== undefined) return existing as T;
        const pending = this.singletonPromises.get(descriptor);
        if (pending) {
          throw new AsyncFactoryError(
            `Async factory detected for ${tokenLabel(
              descriptor.token,
            )}. Use resolveAsync().`,
            descriptor.token,
            descriptor.key,
            stack,
          );
        }
        const created = this.materializeSync(descriptor, scope, stack);
        this.singletons.set(descriptor, created);
        this.singletonDescriptors.add(descriptor);
        this.recordSingletonResolution(descriptor);
        return created;
      }
      case ServiceLifetime.GlobalSingleton: {
        const globalKey = descriptor.globalKey ?? this.globalKeyFor(descriptor);
        if (this.globalCache.has(globalKey)) {
          return this.globalCache.get(globalKey) as T;
        }
        if (this.globalPromises.has(globalKey)) {
          throw new AsyncFactoryError(
            `Async factory detected for ${tokenLabel(
              descriptor.token,
            )}. Use resolveAsync().`,
            descriptor.token,
            descriptor.key,
            stack,
          );
        }
        const created = this.materializeSync(descriptor, scope, stack);
        this.globalCache.set(globalKey, created);
        return created;
      }
      case ServiceLifetime.Scoped: {
        if (!scope) {
          throw new ScopeResolutionError(
            `Cannot resolve scoped service ${tokenLabel(
              descriptor.token,
            )} from root provider. Create a scope first.`,
            descriptor.token,
            descriptor.key,
            stack,
          );
        }
        const pending = scope.getPending(descriptor);
        if (pending) {
          throw new AsyncFactoryError(
            `Async factory detected for ${tokenLabel(
              descriptor.token,
            )}. Use resolveAsync().`,
            descriptor.token,
            descriptor.key,
            stack,
          );
        }
        const cached = scope.getCached(descriptor);
        if (cached !== undefined) return cached as T;
        return scope.getOrCreate(descriptor);
      }
      case ServiceLifetime.Transient:
      default:
        return this.materializeSync(descriptor, scope, stack);
    }
  }

  private resolveInternal<T>(
    tokenLike: TokenLike<T>,
    scope: ServiceScope | null,
    key: ServiceKey | undefined,
    stack: ResolutionFrame[],
    asyncMode: boolean,
  ): T | Promise<T> {
    const { token, optional } = unwrapToken(tokenLike);
    const descriptor = this.pickDescriptor(token, key) as
      | ServiceDescriptor<T>
      | undefined;
    if (!descriptor) {
      if (optional) return undefined as T;
      throw new MissingServiceError(
        key === undefined
          ? `Service not registered: ${tokenLabel(token)}`
          : `Service not registered for token ${tokenLabel(
              token,
            )} with key ${keyLabel(key)}`,
        token,
        key,
        stack,
      );
    }

    const frame: ResolutionFrame = { token, key: descriptor.key ?? key };
    if (stack.some((f) => isSameFrame(f, frame))) {
      const chain = [...stack.map(formatFrame), formatFrame(frame)].join(" -> ");
      throw new CircularDependencyError(
        `Circular dependency detected: ${chain}`,
        [...stack, frame],
      );
    }
    const nextStack = [...stack, frame];
    this.trace(nextStack, descriptor, asyncMode);

    return asyncMode
      ? this.resolveDescriptorAsync(descriptor, scope, nextStack)
      : this.resolveDescriptorSync(descriptor, scope, nextStack);
  }

  private async materializeAsync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionFrame[],
  ): Promise<T> {
    const resolver = this.createScopedResolver(scope, stack);
    const instance = descriptor.factory(resolver);
    return (await instance) as T;
  }

  private materializeSync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionFrame[],
  ): T {
    const resolver = this.createScopedResolver(scope, stack);
    const instance = descriptor.factory(resolver);
    if (isPromise(instance)) {
      throw new AsyncFactoryError(
        `Async factory detected for ${tokenLabel(
          descriptor.token,
        )}. Use resolveAsync().`,
        descriptor.token,
        descriptor.key,
        stack,
      );
    }
    return instance as T;
  }

  private createScopedResolver(
    scope: ServiceScope | null,
    stack: ResolutionFrame[],
  ): ServiceResolver {
    return {
      resolve: <T>(token: TokenLike<T>, key?: ServiceKey) =>
        this.resolveInternal(token, scope, key, stack, false) as T,
      resolveAsync: <T>(token: TokenLike<T>, key?: ServiceKey) =>
        this.resolveInternal(token, scope, key, stack, true) as Promise<T>,
      tryResolve: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        try {
          return this.resolveInternal(token, scope, key, stack, false) as T;
        } catch {
          return undefined;
        }
      },
      tryResolveAsync: async <T>(token: TokenLike<T>, key?: ServiceKey) => {
        try {
          return (await this.resolveInternal(
            token,
            scope,
            key,
            stack,
            true,
          )) as T;
        } catch {
          return undefined;
        }
      },
      resolveAll: <T>(token: Token<T>) =>
        this.resolveAll(token) as unknown as T[],
    };
  }

  private globalKeyFor(descriptor: ServiceDescriptor): string {
    const keyPart =
      descriptor.key !== undefined ? `:${keyLabel(descriptor.key)}` : "";
    return descriptor.globalKey ?? `${tokenLabel(descriptor.token)}${keyPart}`;
  }

  private pickDescriptor<T>(
    token: Token<T>,
    key?: ServiceKey,
  ): ServiceDescriptor<T> | undefined {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length) return undefined;
    if (key === undefined) {
      return descriptors[descriptors.length - 1];
    }
    return descriptors.find((d) => d.key === key);
  }

  private recordSingletonResolution(descriptor: ServiceDescriptor): void {
    if (!this.singletonOrder.includes(descriptor)) {
      this.singletonOrder.push(descriptor);
    }
  }

  private trace(
    path: ResolutionFrame[],
    descriptor: ServiceDescriptor,
    async: boolean,
  ) {
    if (!this.options.trace) return;
    this.options.trace({
      token: descriptor.token,
      key: descriptor.key,
      lifetime: descriptor.lifetime,
      path: path.map((p) => formatFrame(p)),
      async,
    });
  }
}

export async function disposeMany(services: unknown[]): Promise<void> {
  const disposals: Promise<void>[] = [];
  for (const service of services) {
    const disposeFn = getDisposeFn(service);
    if (typeof disposeFn === "function") {
      const result = disposeFn.call(service);
      if (result instanceof Promise) {
        disposals.push(result.then(() => undefined));
      }
    } else if (typeof service === "function") {
      const result = service();
      if (result instanceof Promise) disposals.push(result.then(() => undefined));
    }
  }
  if (disposals.length) {
    await Promise.all(disposals);
  }
}

function getDisposeFn(
  service: unknown,
): (() => void | Promise<void>) | undefined {
  if (
    !service ||
    (typeof service !== "object" && typeof service !== "function")
  ) {
    return undefined;
  }
  const candidate = service as MaybeDisposable & Record<string, unknown>;
  if (typeof candidate.dispose === "function")
    return candidate.dispose.bind(service);
  if (typeof candidate.close === "function")
    return candidate.close.bind(service);
  if (typeof candidate.destroy === "function")
    return candidate.destroy.bind(service);
  const asyncDispose = (Symbol as any).asyncDispose;
  if (asyncDispose && typeof candidate[asyncDispose] === "function") {
    return candidate[asyncDispose].bind(service);
  }
  const syncDispose = (Symbol as any).dispose;
  if (syncDispose && typeof candidate[syncDispose] === "function") {
    return candidate[syncDispose].bind(service);
  }
  return undefined;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as any)?.then === "function";
}

function unwrapToken<T>(
  token: TokenLike<T>,
): { token: Token<T>; optional: boolean } {
  if (typeof token === "object" && (token as any).__optional) {
    return { token: (token as any).token, optional: true };
  }
  return { token: token as Token<T>, optional: false };
}

function isSameFrame(a: ResolutionFrame, b: ResolutionFrame): boolean {
  return a.token === b.token && a.key === b.key;
}

function formatFrame(frame: ResolutionFrame): string {
  return `${tokenLabel(frame.token)}${frame.key !== undefined ? `(${keyLabel(frame.key)})` : ""}`;
}

function getGlobalCache(): Map<string, unknown> {
  const store = globalThis as unknown as Record<string | symbol, unknown>;
  const existing = store[GLOBAL_CACHE_KEY] as Map<string, unknown> | undefined;
  if (existing) return existing;
  const created = new Map<string, unknown>();
  store[GLOBAL_CACHE_KEY] = created;
  return created;
}

function getGlobalPromiseCache(): Map<string, Promise<unknown>> {
  const store = globalThis as unknown as Record<string | symbol, unknown>;
  const existing = store[GLOBAL_PROMISE_CACHE_KEY] as
    | Map<string, Promise<unknown>>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, Promise<unknown>>();
  store[GLOBAL_PROMISE_CACHE_KEY] = created;
  return created;
}

/* istanbul ignore next */
/* c8 ignore start */
function tokenLabel(token: Token): string {
  if (
    typeof token === "string" ||
    typeof token === "number" ||
    typeof token === "symbol"
  ) {
    return String(token);
  }
  return token.name ?? "anonymous";
}

function keyLabel(key: ServiceKey): string {
  return typeof key === "symbol" ? key.toString() : String(key);
}
/* c8 ignore stop */

function sortByPriorityAndOrder<T>(
  items: Array<T>,
  prioritySelector: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const pa = prioritySelector(a);
    const pb = prioritySelector(b);
    if (pb !== pa) return pb - pa;
    return items.indexOf(b) - items.indexOf(a);
  });
}
/* c8 ignore stop */
