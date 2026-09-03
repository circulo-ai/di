import {
  AsyncFactoryError,
  CircularDependencyError,
  DisposedProviderError,
  MissingServiceError,
  ScopeResolutionError,
} from "./errors.js";
import { ServiceLifetime } from "./lifetime.js";
import { ServiceScope } from "./service-scope.js";
import type {
  Diagnostic,
  DiagnosticLevel,
  DisposeFn,
  InterceptorFrequency,
  InterceptorOptions,
  MaybeDisposable,
  PostResolutionInterceptorCallback,
  PreResolutionInterceptorCallback,
  ResolutionType,
  ServiceDescriptor,
  ServiceKey,
  ServiceResolver,
  Token,
  TokenLike,
  TraceEvent,
} from "./types.js";

type ResolutionFrame = { token: Token; key?: ServiceKey };
type ResolutionStack = ResolutionFrame[] & {
  resolutionCache?: Map<ServiceDescriptor, unknown>;
};

const GLOBAL_CACHE_KEY = Symbol.for("@circulo-ai/di:globals");
const GLOBAL_PROMISE_CACHE_KEY = Symbol.for("@circulo-ai/di:globals:promises");
const GLOBAL_IDENTITY_KEY = Symbol.for("@circulo-ai/di:global-identities");

type GlobalIdentityStore = {
  explicit: Map<string, object>;
  keyed: Map<Token, Map<ServiceKey, object>>;
  disposers: Map<unknown, GlobalDisposalRecord>;
};

type GlobalDisposalRecord = {
  dispose: DisposeFn;
  priority: number;
  order: number;
};

export class ServiceProvider implements ServiceResolver {
  private readonly descriptors: Map<Token, ServiceDescriptor[]>;
  private readonly descriptorSet: Set<ServiceDescriptor>;
  private singletons = new WeakMap<ServiceDescriptor, unknown>();
  private singletonPromises = new WeakMap<
    ServiceDescriptor,
    Promise<unknown>
  >();
  private readonly singletonOrder: ServiceDescriptor[] = [];
  private readonly providerOwnedInstances: Array<{
    descriptor: ServiceDescriptor;
    instance: unknown;
  }> = [];
  private readonly disposeHandlers: Array<{ fn: DisposeFn; priority: number }> =
    [];
  private readonly scopes = new Set<ServiceScope>();
  private readonly globalCache: Map<unknown, unknown>;
  private readonly globalPromises: Map<unknown, Promise<unknown>>;
  private readonly fallback?: ServiceResolver;
  private readonly preResolution = new Map<
    Token,
    Array<{
      callback: PreResolutionInterceptorCallback;
      frequency: InterceptorFrequency;
    }>
  >();
  private readonly postResolution = new Map<
    Token,
    Array<{
      callback: PostResolutionInterceptorCallback;
      frequency: InterceptorFrequency;
    }>
  >();
  private readonly traceListeners = new Set<(event: TraceEvent) => void>();
  private disposed = false;
  private disposing: Promise<void> | undefined;

  constructor(
    descriptors: ServiceDescriptor[],
    private readonly options: {
      trace?: (event: TraceEvent) => void;
      fallback?: ServiceResolver;
    } = {},
  ) {
    this.descriptorSet = new Set(descriptors);
    const grouped = new Map<Token, ServiceDescriptor[]>();
    descriptors.forEach((d) => {
      const list = grouped.get(d.token) ?? [];
      list.push(d);
      grouped.set(d.token, list);
    });
    this.descriptors = grouped;
    this.globalCache = getGlobalCache();
    this.globalPromises = getGlobalPromiseCache();
    this.fallback = options.fallback;
  }

  /** Subscribe to resolution trace events without rebuilding the provider. */
  onTrace(listener: (event: TraceEvent) => void): () => void {
    this.assertActive();
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }

  onDispose(handler: DisposeFn): void {
    this.assertActive();
    this.onDisposeWithPriority(handler);
  }

  onDisposeWithPriority(handler: DisposeFn, priority = 0): void {
    this.assertActive();
    this.disposeHandlers.push({ fn: handler, priority });
  }

  async withScope<T>(
    work: (scope: ServiceScope) => Promise<T> | T,
  ): Promise<T> {
    this.assertActive();
    const scope = this.createScope();
    try {
      return await work(scope);
    } finally {
      await scope.dispose();
    }
  }

  resolve<T>(token: TokenLike<T>, key?: ServiceKey): T {
    this.assertActive();
    return this.resolveInternal(
      token,
      null,
      key,
      newResolutionStack(),
      false,
    ) as T;
  }

  getRequiredService<T>(token: TokenLike<T>, key?: ServiceKey): T {
    return this.resolve(token, key);
  }

  getService<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
    const { token: innerToken, optional } = unwrapToken(token);
    if (
      !optional &&
      !this.pickDescriptor(innerToken, key) &&
      !(this.fallback?.isRegistered?.(innerToken, true) ?? false)
    )
      return undefined;
    return this.resolve(token, key);
  }

  getServices<T>(token: Token<T>): T[] {
    return this.resolveAll(token);
  }

  getServicesAsync<T>(token: Token<T>): Promise<T[]> {
    return this.resolveAllAsync(token);
  }

  async resolveAsync<T>(token: TokenLike<T>, key?: ServiceKey): Promise<T> {
    this.assertActive();
    return (await this.resolveInternal(
      token,
      null,
      key,
      newResolutionStack(),
      true,
    )) as T;
  }

  tryResolve<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
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
    this.assertActive();
    try {
      return await this.resolveAsync(token, key);
    } catch {
      return undefined;
    }
  }

  tryResolveMissing<T>(token: TokenLike<T>, key?: ServiceKey): T | undefined {
    this.assertActive();
    try {
      return this.resolve(token, key);
    } catch (error) {
      if (error instanceof MissingServiceError) return undefined;
      throw error;
    }
  }

  async tryResolveMissingAsync<T>(
    token: TokenLike<T>,
    key?: ServiceKey,
  ): Promise<T | undefined> {
    this.assertActive();
    try {
      return await this.resolveAsync(token, key);
    } catch (error) {
      if (error instanceof MissingServiceError) return undefined;
      throw error;
    }
  }

  resolveAll<T>(token: Token<T>): T[] {
    this.assertActive();
    return this.resolveAllInternal(token, null, newResolutionStack());
  }

  async resolveAllAsync<T>(token: Token<T>): Promise<T[]> {
    this.assertActive();
    return this.resolveAllAsyncInternal(token, null, newResolutionStack());
  }

  resolveAllFromScope<T>(token: Token<T>, scope: ServiceScope): T[] {
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveAllInternal(token, scope, []);
  }

  resolveAllFromScopeAsync<T>(
    token: Token<T>,
    scope: ServiceScope,
  ): Promise<T[]> {
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveAllAsyncInternal(token, scope, []);
  }

  private resolveAllInternal<T>(
    token: Token<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): T[] {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length) {
      return this.fallback?.resolveAll(token) ?? [];
    }
    this.executePreResolutionInterceptor(token, "All");
    const result = descriptors.map((descriptor) => {
      const frame: ResolutionFrame = { token, key: descriptor.key };
      if (stack.some((entry) => isSameFrame(entry, frame))) {
        const path = [...stack, frame];
        this.trace(path, descriptor, false);
        throw new CircularDependencyError(
          `Circular dependency detected: ${path.map(formatFrame).join(" -> ")}`,
          path,
        );
      }
      const nextStack = appendFrame(stack, frame);
      this.trace(nextStack, descriptor, false);
      return this.resolveDescriptorSync(descriptor, scope, nextStack);
    });
    this.executePostResolutionInterceptor(token, result, "All");
    return result;
  }

  private async resolveAllAsyncInternal<T>(
    token: Token<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): Promise<T[]> {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length)
      return this.fallback?.resolveAllAsync(token) ?? [];
    this.executePreResolutionInterceptor(token, "All");
    const result = await Promise.all(
      descriptors.map(async (descriptor) => {
        const frame: ResolutionFrame = { token, key: descriptor.key };
        if (stack.some((entry) => isSameFrame(entry, frame))) {
          const path = [...stack, frame];
          this.trace(path, descriptor, true);
          throw new CircularDependencyError(
            `Circular dependency detected: ${path.map(formatFrame).join(" -> ")}`,
            path,
          );
        }
        const nextStack = appendFrame(stack, frame);
        this.trace(nextStack, descriptor, true);
        return this.resolveDescriptorAsync(descriptor, scope, nextStack);
      }),
    );
    this.executePostResolutionInterceptor(token, result, "All");
    return result;
  }

  resolveMap<T>(token: Token<T>): Record<ServiceKey, T> {
    this.assertActive();
    return this.resolveMapInternal(token, null, newResolutionStack());
  }

  async resolveMapAsync<T>(token: Token<T>): Promise<Record<ServiceKey, T>> {
    this.assertActive();
    return this.resolveMapAsyncInternal(token, null, newResolutionStack());
  }

  resolveMapFromScope<T>(
    token: Token<T>,
    scope: ServiceScope,
  ): Record<ServiceKey, T> {
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveMapInternal(token, scope, []);
  }

  resolveMapFromScopeAsync<T>(
    token: Token<T>,
    scope: ServiceScope,
  ): Promise<Record<ServiceKey, T>> {
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveMapAsyncInternal(token, scope, []);
  }

  private resolveMapInternal<T>(
    token: Token<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): Record<ServiceKey, T> {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length) return this.fallback?.resolveMap(token) ?? {};
    const map: Record<ServiceKey, T> = {} as Record<ServiceKey, T>;
    for (const d of descriptors) {
      if (d.key === undefined) {
        throw new Error(
          `resolveMap requires keyed registrations for token ${tokenLabel(token)}`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(map, d.key)) {
        throw new Error(
          `Duplicate key ${keyLabel(d.key)} for token ${tokenLabel(token)}`,
        );
      }
      const frame: ResolutionFrame = { token, key: d.key };
      if (stack.some((entry) => isSameFrame(entry, frame))) {
        const path = [...stack, frame];
        this.trace(path, d, false);
        throw new CircularDependencyError(
          `Circular dependency detected: ${path.map(formatFrame).join(" -> ")}`,
          path,
        );
      }
      const nextStack = appendFrame(stack, frame);
      this.trace(nextStack, d, false);
      Object.defineProperty(map, d.key, {
        value: this.resolveDescriptorSync(d, scope, nextStack),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return map;
  }

  private async resolveMapAsyncInternal<T>(
    token: Token<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): Promise<Record<ServiceKey, T>> {
    const descriptors = this.descriptors.get(token) as
      | ServiceDescriptor<T>[]
      | undefined;
    if (!descriptors?.length)
      return this.fallback?.resolveMapAsync(token) ?? {};

    const keys = new Set<ServiceKey>();
    for (const descriptor of descriptors) {
      if (descriptor.key === undefined) {
        throw new Error(
          `resolveMap requires keyed registrations for token ${tokenLabel(token)}`,
        );
      }
      if (keys.has(descriptor.key)) {
        throw new Error(
          `Duplicate key ${keyLabel(descriptor.key)} for token ${tokenLabel(token)}`,
        );
      }
      keys.add(descriptor.key);
    }

    const entries = await Promise.all(
      descriptors.map(async (descriptor) => {
        const key = descriptor.key;
        if (key === undefined) {
          throw new Error(
            `resolveMap requires keyed registrations for token ${tokenLabel(token)}`,
          );
        }
        const frame: ResolutionFrame = { token, key };
        if (stack.some((entry) => isSameFrame(entry, frame))) {
          const path = [...stack, frame];
          this.trace(path, descriptor, true);
          throw new CircularDependencyError(
            `Circular dependency detected: ${path.map(formatFrame).join(" -> ")}`,
            path,
          );
        }
        const nextStack = appendFrame(stack, frame);
        this.trace(nextStack, descriptor, true);
        return [
          key,
          await this.resolveDescriptorAsync(descriptor, scope, nextStack),
        ] as const;
      }),
    );

    const map: Record<ServiceKey, T> = {} as Record<ServiceKey, T>;
    for (const [key, value] of entries) {
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new Error(
          `Duplicate key ${keyLabel(key)} for token ${tokenLabel(token)}`,
        );
      }
      Object.defineProperty(map, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return map;
  }

  createScope(): ServiceScope {
    this.assertActive();
    return new ServiceScope(this);
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    if (this.disposed) return;
    this.disposed = true;
    this.disposing = this.disposeInternal();
    return this.disposing;
  }

  private async disposeInternal(): Promise<void> {
    const errors: unknown[] = [];

    const scopes = [...this.scopes];
    const scopeResults = await Promise.allSettled(
      scopes.map((scope) => scope.dispose()),
    );
    for (const result of scopeResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    const pending: Promise<unknown>[] = [];
    for (const descriptors of this.descriptors.values()) {
      for (const descriptor of descriptors) {
        const promise = this.singletonPromises.get(descriptor);
        if (promise) pending.push(promise);
      }
    }
    await Promise.allSettled(pending);

    const sortedHandlers = [...this.disposeHandlers].sort(
      (a, b) => b.priority - a.priority,
    );
    await disposeFunctions(sortedHandlers.map((handler) => handler.fn)).catch(
      (error) => errors.push(error),
    );

    const instances: Array<{
      descriptor: ServiceDescriptor;
      instance: unknown;
    }> = [];
    for (const descriptor of this.singletonOrder) {
      const value = this.singletons.get(descriptor);
      if (value !== undefined) {
        instances.push({ descriptor, instance: value });
      }
    }
    await disposeMany(
      sortByPriorityAndOrder(
        instances.filter(
          (item) =>
            effectiveDisposal(item.descriptor) === "provider" &&
            !item.descriptor.customDispose,
        ),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.instance),
    ).catch((error) => errors.push(error));
    await disposeFunctions(
      sortByPriorityAndOrder(
        this.singletonOrder
          .map((d) => ({ descriptor: d, dispose: d.customDispose }))
          .filter(
            (d) => d.dispose && effectiveDisposal(d.descriptor) === "provider",
          ),
        (i) => i.descriptor.disposePriority,
      ).map((i) => i.dispose as DisposeFn),
    ).catch((error) => errors.push(error));
    await disposeOwnedInstances(this.providerOwnedInstances, errors);
    this.singletons = new WeakMap();
    this.singletonPromises = new WeakMap();
    this.singletonOrder.length = 0;
    this.providerOwnedInstances.length = 0;
    this.disposeHandlers.length = 0;
    this.scopes.clear();
    throwDisposalErrors(errors);
  }

  /** @internal Called by ServiceScope. */
  registerScope(scope: ServiceScope): void {
    this.scopes.add(scope);
  }

  /** @internal Called by ServiceScope. */
  unregisterScope(scope: ServiceScope): void {
    this.scopes.delete(scope);
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

  /** Whether this provider has completed disposal. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Check this provider, and optionally its fallback provider, for a token. */
  isRegistered(token: Token, recursive = false): boolean {
    this.assertActive();
    return (
      this.has(token) ||
      (recursive && (this.fallback?.isRegistered?.(token, true) ?? false))
    );
  }

  /** Register a callback before a token is resolved. */
  beforeResolution<T>(
    token: Token<T>,
    callback: PreResolutionInterceptorCallback<T>,
    options: InterceptorOptions = {},
  ): void {
    this.assertActive();
    const callbacks = this.preResolution.get(token) ?? [];
    callbacks.push({
      callback: callback as PreResolutionInterceptorCallback,
      frequency: options.frequency ?? "Always",
    });
    this.preResolution.set(token, callbacks);
  }

  /** Register a callback after a token is resolved successfully. */
  afterResolution<T>(
    token: Token<T>,
    callback: PostResolutionInterceptorCallback<T>,
    options: InterceptorOptions = {},
  ): void {
    this.assertActive();
    const callbacks = this.postResolution.get(token) ?? [];
    callbacks.push({
      callback: callback as PostResolutionInterceptorCallback,
      frequency: options.frequency ?? "Always",
    });
    this.postResolution.set(token, callbacks);
  }

  /** Clear cached instances while retaining registrations. */
  clearInstances(): void {
    this.assertActive();
    this.singletons = new WeakMap();
    this.singletonPromises = new WeakMap();
    this.singletonOrder.length = 0;
    this.providerOwnedInstances.length = 0;
    for (const scope of this.scopes) scope.clearInstances();
  }

  /** Clear registrations and interceptors while retaining the provider. */
  reset(): void {
    this.assertActive();
    this.replaceAllDescriptors([]);
    this.preResolution.clear();
    this.postResolution.clear();
  }

  /** @internal Synchronizes descriptors after a mutable collection update. */
  replaceTokenDescriptors(
    token: Token,
    descriptors: ServiceDescriptor[],
  ): void {
    this.assertActive();
    const previous = this.descriptors.get(token) ?? [];
    for (const descriptor of previous) {
      this.descriptorSet.delete(descriptor);
      this.singletons.delete(descriptor);
      this.singletonPromises.delete(descriptor);
    }
    this.singletonOrder.splice(
      0,
      this.singletonOrder.length,
      ...this.singletonOrder.filter((d) => !previous.includes(d)),
    );
    this.descriptors.set(token, [...descriptors]);
    for (const descriptor of descriptors) this.descriptorSet.add(descriptor);
  }

  /** @internal Synchronizes all descriptors after a collection reset. */
  replaceAllDescriptors(descriptors: ServiceDescriptor[]): void {
    this.assertActive();
    this.descriptors.clear();
    this.descriptorSet.clear();
    for (const descriptor of descriptors) {
      const list = this.descriptors.get(descriptor.token) ?? [];
      list.push(descriptor);
      this.descriptors.set(descriptor.token, list);
      this.descriptorSet.add(descriptor);
    }
    this.clearInstances();
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
          const level: DiagnosticLevel =
            key === undefined ? "warning" : "error";
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

    const dependencyGraph = new Map<ServiceDescriptor, ServiceDescriptor[]>();
    for (const descriptors of this.descriptors.values()) {
      for (const descriptor of descriptors) {
        const dependencies: ServiceDescriptor[] = [];
        for (const dependency of descriptor.dependencies ?? []) {
          const { token, optional } = unwrapToken(dependency);
          const dependencyDescriptor = this.pickDescriptor(token);
          if (!dependencyDescriptor) {
            if (!optional) {
              diagnostics.push({
                level: "error",
                message: `Missing dependency ${tokenLabel(token)} required by ${tokenLabel(descriptor.token)}.`,
                token: descriptor.token,
                path: [descriptor.token, token],
              });
            }
            continue;
          }
          dependencies.push(dependencyDescriptor);
          if (
            (descriptor.lifetime === ServiceLifetime.Singleton ||
              descriptor.lifetime === ServiceLifetime.GlobalSingleton) &&
            dependencyDescriptor.lifetime === ServiceLifetime.Scoped
          ) {
            diagnostics.push({
              level: "error",
              message: `Captive dependency: ${tokenLabel(descriptor.token)} (${descriptor.lifetime}) depends on scoped service ${tokenLabel(dependencyDescriptor.token)}.`,
              token: descriptor.token,
              path: [descriptor.token, dependencyDescriptor.token],
            });
          }
        }
        dependencyGraph.set(descriptor, dependencies);
      }
    }

    const visited = new Set<ServiceDescriptor>();
    const active = new Set<ServiceDescriptor>();
    const walk = (descriptor: ServiceDescriptor, path: Token[]): void => {
      if (active.has(descriptor)) {
        diagnostics.push({
          level: "error",
          message: `Circular dependency detected during validation: ${[
            ...path,
            descriptor.token,
          ]
            .map(tokenLabel)
            .join(" -> ")}`,
          token: descriptor.token,
          path: [...path, descriptor.token],
        });
        return;
      }
      if (visited.has(descriptor)) return;
      visited.add(descriptor);
      active.add(descriptor);
      for (const dependency of dependencyGraph.get(descriptor) ?? []) {
        walk(dependency, [...path, descriptor.token]);
      }
      active.delete(descriptor);
    };
    for (const descriptor of dependencyGraph.keys()) walk(descriptor, []);

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
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveInternal(
      token,
      scope,
      key,
      newResolutionStack(),
      false,
    ) as T;
  }

  resolveFromScopeMissing<T>(
    token: TokenLike<T>,
    scope: ServiceScope,
    key?: ServiceKey,
  ): T | undefined {
    try {
      return this.resolveFromScope(token, scope, key);
    } catch (error) {
      if (error instanceof MissingServiceError) return undefined;
      throw error;
    }
  }

  resolveFromScopeAsync<T>(
    token: TokenLike<T>,
    scope: ServiceScope,
    key?: ServiceKey,
  ): Promise<T> {
    this.assertActive();
    this.assertOwnedScope(scope);
    return this.resolveInternal(
      token,
      scope,
      key,
      newResolutionStack(),
      true,
    ) as Promise<T>;
  }

  async resolveFromScopeMissingAsync<T>(
    token: TokenLike<T>,
    scope: ServiceScope,
    key?: ServiceKey,
  ): Promise<T | undefined> {
    try {
      return await this.resolveFromScopeAsync(token, scope, key);
    } catch (error) {
      if (error instanceof MissingServiceError) return undefined;
      throw error;
    }
  }

  resolveDescriptor<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
  ): T {
    this.assertActive();
    this.assertOwnedDescriptor(descriptor, scope);
    return this.resolveDescriptorSync(descriptor, scope, newResolutionStack());
  }

  async resolveDescriptorAsync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): Promise<T> {
    this.assertActive();
    this.assertOwnedDescriptor(descriptor, scope);
    this.assertScopeDependencyAllowed(descriptor, scope, stack);
    switch (descriptor.lifetime) {
      case ServiceLifetime.Singleton: {
        if (this.singletons.has(descriptor)) {
          return this.singletons.get(descriptor) as T;
        }

        const inflight = this.singletonPromises.get(descriptor);
        if (inflight) return inflight as Promise<T>;

        const promise = this.materializeAsync(descriptor, scope, stack);
        this.singletonPromises.set(descriptor, promise);
        try {
          const created = await promise;
          this.singletons.set(descriptor, created);
          this.recordSingletonResolution(descriptor);
          return created;
        } finally {
          this.singletonPromises.delete(descriptor);
        }
      }
      case ServiceLifetime.GlobalSingleton: {
        const globalKey = this.globalKeyFor(descriptor);
        if (this.globalCache.has(globalKey)) {
          return this.globalCache.get(globalKey) as T;
        }
        const inflight = this.globalPromises.get(globalKey);
        if (inflight) return inflight as Promise<T>;
        const promise = this.materializeAsync(descriptor, scope, stack);
        this.globalPromises.set(globalKey, promise);
        try {
          const created = await promise;
          this.globalCache.set(globalKey, created);
          registerGlobalDisposer(globalKey, descriptor, created);
          return created;
        } finally {
          this.globalPromises.delete(globalKey);
        }
      }
      case ServiceLifetime.ContainerScoped: {
        if (this.singletons.has(descriptor)) {
          return this.singletons.get(descriptor) as T;
        }
        const inflight = this.singletonPromises.get(descriptor);
        if (inflight) return inflight as Promise<T>;
        const promise = this.materializeAsync(descriptor, scope, stack);
        this.singletonPromises.set(descriptor, promise);
        try {
          const created = await promise;
          this.singletons.set(descriptor, created);
          this.recordSingletonResolution(descriptor);
          return created;
        } finally {
          this.singletonPromises.delete(descriptor);
        }
      }
      case ServiceLifetime.ResolutionScoped: {
        const cache = getResolutionCache(stack);
        if (cache.has(descriptor)) return cache.get(descriptor) as T;
        const created = await this.materializeAsync(descriptor, scope, stack);
        cache.set(descriptor, created);
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
        if (scope.hasCached(descriptor)) {
          return scope.getCached(descriptor) as T;
        }

        const pending = scope.getPending(descriptor);
        if (pending) return pending as Promise<T>;

        const promise = this.materializeAsync(descriptor, scope, stack);
        scope.setPending(descriptor, promise);
        try {
          const created = await promise;
          scope.setInstance(descriptor, created);
          if (effectiveDisposal(descriptor) === "provider") {
            this.trackProviderOwned(descriptor, created);
          }
          return created;
        } finally {
          scope.clearPending(descriptor);
        }
      }
      case ServiceLifetime.Transient:
      default: {
        const created = await this.materializeAsync(descriptor, scope, stack);
        this.trackOwnedTransient(descriptor, created, scope);
        return created;
      }
    }
  }

  private resolveDescriptorSync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): T {
    this.assertScopeDependencyAllowed(descriptor, scope, stack);
    switch (descriptor.lifetime) {
      case ServiceLifetime.Singleton: {
        if (this.singletons.has(descriptor)) {
          return this.singletons.get(descriptor) as T;
        }
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
        this.recordSingletonResolution(descriptor);
        return created;
      }
      case ServiceLifetime.GlobalSingleton: {
        const globalKey = this.globalKeyFor(descriptor);
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
        registerGlobalDisposer(globalKey, descriptor, created);
        return created;
      }
      case ServiceLifetime.ContainerScoped: {
        if (this.singletons.has(descriptor)) {
          return this.singletons.get(descriptor) as T;
        }
        const created = this.materializeSync(descriptor, scope, stack);
        this.singletons.set(descriptor, created);
        this.recordSingletonResolution(descriptor);
        return created;
      }
      case ServiceLifetime.ResolutionScoped: {
        const cache = getResolutionCache(stack);
        if (cache.has(descriptor)) return cache.get(descriptor) as T;
        const created = this.materializeSync(descriptor, scope, stack);
        cache.set(descriptor, created);
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
        if (scope.hasCached(descriptor)) {
          return scope.getCached(descriptor) as T;
        }
        const created = this.materializeSync(descriptor, scope, stack);
        scope.setInstance(descriptor, created);
        if (effectiveDisposal(descriptor) === "provider") {
          this.trackProviderOwned(descriptor, created);
        }
        return created;
      }
      case ServiceLifetime.Transient:
      default: {
        const created = this.materializeSync(descriptor, scope, stack);
        this.trackOwnedTransient(descriptor, created, scope);
        return created;
      }
    }
  }

  private resolveInternal<T>(
    tokenLike: TokenLike<T>,
    scope: ServiceScope | null,
    key: ServiceKey | undefined,
    stack: ResolutionStack,
    asyncMode: boolean,
  ): T | Promise<T> {
    const { token, optional } = unwrapToken(tokenLike);
    const descriptor = this.pickDescriptor(token, key) as
      | ServiceDescriptor<T>
      | undefined;
    if (!descriptor) {
      if (isDelayedToken(token)) {
        const resolveDelayed = (constructor: Token) =>
          this.resolveInternal(
            constructor as TokenLike,
            scope,
            key,
            stack,
            false,
          ) as T;
        return token.createProxy(resolveDelayed as never) as T;
      }
      if (this.fallback) {
        return asyncMode
          ? this.fallback.resolveAsync(tokenLike, key)
          : this.fallback.resolve(tokenLike, key);
      }
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
      this.trace([...stack, frame], descriptor, asyncMode);
      const chain = [...stack.map(formatFrame), formatFrame(frame)].join(
        " -> ",
      );
      throw new CircularDependencyError(
        `Circular dependency detected: ${chain}`,
        [...stack, frame],
      );
    }
    const nextStack = appendFrame(stack, frame);
    this.trace(nextStack, descriptor, asyncMode);
    this.executePreResolutionInterceptor(token, "Single");

    if (asyncMode) {
      return this.resolveDescriptorAsync(descriptor, scope, nextStack).then(
        (result) => {
          this.executePostResolutionInterceptor(token, result, "Single");
          return result;
        },
      );
    }
    const result = this.resolveDescriptorSync(descriptor, scope, nextStack);
    this.executePostResolutionInterceptor(token, result, "Single");
    return result;
  }

  private async materializeAsync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): Promise<T> {
    const resolver = this.createScopedResolver(scope, stack, descriptor);
    const instance = descriptor.factory(resolver);
    return (await instance) as T;
  }

  private materializeSync<T>(
    descriptor: ServiceDescriptor<T>,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): T {
    const resolver = this.createScopedResolver(scope, stack, descriptor);
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
    stack: ResolutionStack,
    owner: ServiceDescriptor,
  ): ServiceResolver {
    const assertResolverActive = () => {
      this.assertActive();
      scope?.assertResolutionActive(owner);
    };
    return {
      resolve: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        return this.resolveInternal(token, scope, key, stack, false) as T;
      },
      resolveAsync: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        return this.resolveInternal(
          token,
          scope,
          key,
          stack,
          true,
        ) as Promise<T>;
      },
      tryResolve: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        try {
          return this.resolveInternal(token, scope, key, stack, false) as T;
        } catch {
          return undefined;
        }
      },
      tryResolveMissing: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        try {
          return this.resolveInternal(token, scope, key, stack, false) as T;
        } catch (error) {
          if (error instanceof MissingServiceError) return undefined;
          throw error;
        }
      },
      tryResolveAsync: async <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
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
      tryResolveMissingAsync: async <T>(
        token: TokenLike<T>,
        key?: ServiceKey,
      ) => {
        assertResolverActive();
        try {
          return (await this.resolveInternal(
            token,
            scope,
            key,
            stack,
            true,
          )) as T;
        } catch (error) {
          if (error instanceof MissingServiceError) return undefined;
          throw error;
        }
      },
      resolveAll: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveAllInternal(token, scope, stack);
      },
      resolveAllAsync: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveAllAsyncInternal(token, scope, stack);
      },
      resolveMap: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveMapInternal(token, scope, stack);
      },
      resolveMapAsync: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveMapAsyncInternal(token, scope, stack);
      },
      getRequiredService: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        return this.resolveInternal(token, scope, key, stack, false) as T;
      },
      getService: <T>(token: TokenLike<T>, key?: ServiceKey) => {
        assertResolverActive();
        const { token: innerToken, optional } = unwrapToken(token);
        if (!optional && !this.pickDescriptor(innerToken, key))
          return undefined;
        return this.resolveInternal(token, scope, key, stack, false) as T;
      },
      getServices: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveAllInternal(token, scope, stack);
      },
      getServicesAsync: <T>(token: Token<T>) => {
        assertResolverActive();
        return this.resolveAllAsyncInternal(token, scope, stack);
      },
      isRegistered: (token: Token, recursive = true) => {
        assertResolverActive();
        return this.isRegistered(token, recursive);
      },
    };
  }

  private trackOwnedTransient(
    descriptor: ServiceDescriptor,
    instance: unknown,
    scope: ServiceScope | null,
  ): void {
    if (effectiveDisposal(descriptor) === "scope" && scope) {
      scope.trackOwnedInstance(descriptor, instance);
      return;
    }
    if (effectiveDisposal(descriptor) === "provider" || !scope) {
      this.trackProviderOwned(descriptor, instance);
    }
  }

  private trackProviderOwned(
    descriptor: ServiceDescriptor,
    instance: unknown,
  ): void {
    this.providerOwnedInstances.push({ descriptor, instance });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new DisposedProviderError();
    }
  }

  private assertOwnedDescriptor(
    descriptor: ServiceDescriptor,
    scope: ServiceScope | null,
  ): void {
    if (!this.descriptorSet.has(descriptor)) {
      throw new Error(
        "The service descriptor does not belong to this provider.",
      );
    }
    if (scope) this.assertOwnedScope(scope);
  }

  private assertOwnedScope(scope: ServiceScope): void {
    if (!this.scopes.has(scope)) {
      throw new Error("The service scope does not belong to this provider.");
    }
  }

  private assertScopeDependencyAllowed(
    descriptor: ServiceDescriptor,
    scope: ServiceScope | null,
    stack: ResolutionStack,
  ): void {
    if (descriptor.lifetime !== ServiceLifetime.Scoped || !scope) return;
    const captive = stack.some((frame) => {
      const parent = this.pickDescriptor(frame.token, frame.key);
      return (
        parent?.lifetime === ServiceLifetime.Singleton ||
        parent?.lifetime === ServiceLifetime.GlobalSingleton
      );
    });
    if (captive) {
      throw new ScopeResolutionError(
        `Cannot resolve scoped service ${tokenLabel(
          descriptor.token,
        )} while constructing a singleton. Scoped services must not escape into singleton state.`,
        descriptor.token,
        descriptor.key,
        [...stack, { token: descriptor.token, key: descriptor.key }],
      );
    }
  }

  private globalKeyFor(descriptor: ServiceDescriptor): unknown {
    const identities = getGlobalIdentityStore();
    if (descriptor.globalKey !== undefined) {
      let identity = identities.explicit.get(descriptor.globalKey);
      if (!identity) {
        identity = {};
        identities.explicit.set(descriptor.globalKey, identity);
      }
      return identity;
    }
    if (descriptor.key === undefined) return descriptor.token;
    let keys = identities.keyed.get(descriptor.token);
    if (!keys) {
      keys = new Map();
      identities.keyed.set(descriptor.token, keys);
    }
    let identity = keys.get(descriptor.key);
    if (!identity) {
      identity = {};
      keys.set(descriptor.key, identity);
    }
    return identity;
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
    if (!this.options.trace && this.traceListeners.size === 0) return;
    const event: TraceEvent = {
      token: descriptor.token,
      key: descriptor.key,
      lifetime: descriptor.lifetime,
      path: path.map((p) => formatFrame(p)),
      pathEntries: path.map((p) => ({ token: p.token, key: p.key })),
      async,
    };
    this.options.trace?.(event);
    for (const listener of this.traceListeners) listener(event);
  }

  private executePreResolutionInterceptor(
    token: Token,
    resolutionType: ResolutionType,
  ): void {
    const callbacks = this.preResolution.get(token);
    if (!callbacks?.length) return;
    const remaining = callbacks.filter((entry) => entry.frequency !== "Once");
    for (const entry of callbacks) entry.callback(token, resolutionType);
    if (remaining.length) this.preResolution.set(token, remaining);
    else this.preResolution.delete(token);
  }

  private executePostResolutionInterceptor(
    token: Token,
    result: unknown,
    resolutionType: ResolutionType,
  ): void {
    const callbacks = this.postResolution.get(token);
    if (!callbacks?.length) return;
    const remaining = callbacks.filter((entry) => entry.frequency !== "Once");
    for (const entry of callbacks) {
      entry.callback(token, result as never, resolutionType);
    }
    if (remaining.length) this.postResolution.set(token, remaining);
    else this.postResolution.delete(token);
  }
}

export async function disposeMany(services: unknown[]): Promise<void> {
  const disposals: Promise<void>[] = [];
  const errors: unknown[] = [];
  for (const service of services) {
    const disposeFn = getDisposeFn(service);
    if (typeof disposeFn === "function") {
      try {
        disposals.push(Promise.resolve(disposeFn.call(service)));
      } catch (error) {
        errors.push(error);
      }
    }
  }
  const results = await Promise.allSettled(disposals);
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  throwDisposalErrors(errors);
}

/** Dispose explicitly global-owned services and clear their process cache. */
export async function disposeGlobalServices(): Promise<void> {
  const cache = getGlobalCache();
  const promises = getGlobalPromiseCache();
  await Promise.allSettled([...promises.values()]);

  const identities = getGlobalIdentityStore();
  const records = [...identities.disposers.entries()].sort(
    ([, a], [, b]) => b.priority - a.priority || b.order - a.order,
  );
  const errors: unknown[] = [];
  await disposeFunctions(records.map(([, record]) => record.dispose)).catch(
    (error) => errors.push(error),
  );

  identities.disposers.clear();
  cache.clear();
  promises.clear();
  throwDisposalErrors(errors);
}

export async function disposeFunctions(functions: DisposeFn[]): Promise<void> {
  const results = await Promise.allSettled(
    functions.map(async (dispose) => await dispose()),
  );
  throwDisposalErrors(
    results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason),
  );
}

async function disposeOwnedInstances(
  instances: Array<{ descriptor: ServiceDescriptor; instance: unknown }>,
  errors: unknown[],
): Promise<void> {
  const ordered = [...instances].sort(
    (a, b) =>
      b.descriptor.disposePriority - a.descriptor.disposePriority ||
      instances.indexOf(b) - instances.indexOf(a),
  );
  await disposeMany(
    ordered
      .filter((item) => !item.descriptor.customDispose)
      .map((item) => item.instance),
  ).catch((error) => errors.push(error));
  await disposeFunctions(
    ordered
      .filter((item) => item.descriptor.customDispose)
      .map((item) => item.descriptor.customDispose as DisposeFn),
  ).catch((error) => errors.push(error));
}

function registerGlobalDisposer(
  key: unknown,
  descriptor: ServiceDescriptor,
  instance: unknown,
): void {
  if (effectiveDisposal(descriptor) !== "global") return;
  const store = getGlobalIdentityStore();
  if (store.disposers.has(key)) return;
  const dispose = descriptor.customDispose ?? getDisposeFn(instance);
  if (!dispose) return;
  store.disposers.set(key, {
    dispose,
    priority: descriptor.disposePriority,
    order: store.disposers.size,
  });
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

function unwrapToken<T>(token: TokenLike<T>): {
  token: Token<T>;
  optional: boolean;
} {
  if (isOptionalToken(token)) {
    return { token: token.token as Token<T>, optional: true };
  }
  if (!isRuntimeToken(token)) {
    throw new TypeError("Invalid service token.");
  }
  return { token: token as Token<T>, optional: false };
}

function isOptionalToken(value: unknown): value is {
  __optional: true;
  token: Token;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { __optional?: unknown; token?: unknown };
  if (candidate.__optional !== true) return false;
  if (!isRuntimeToken(candidate.token)) {
    throw new TypeError("Optional token must wrap a valid service token.");
  }
  return true;
}

function isRuntimeToken(value: unknown): value is Token {
  return (
    typeof value === "string" ||
    typeof value === "symbol" ||
    typeof value === "function" ||
    isDelayedToken(value)
  );
}

function isDelayedToken(value: unknown): value is Token & {
  createProxy(resolve: (constructor: Token) => unknown): unknown;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { __delayed?: unknown }).__delayed === true &&
    typeof (value as { createProxy?: unknown }).createProxy === "function",
  );
}

function newResolutionStack(): ResolutionStack {
  const stack: ResolutionStack = [];
  stack.resolutionCache = new Map();
  return stack;
}

function appendFrame(
  stack: ResolutionStack,
  frame: ResolutionFrame,
): ResolutionStack {
  const next = [...stack] as ResolutionStack;
  next.resolutionCache = stack.resolutionCache;
  next.push(frame);
  return next;
}

function getResolutionCache(
  stack: ResolutionStack,
): Map<ServiceDescriptor, unknown> {
  if (!stack.resolutionCache) stack.resolutionCache = new Map();
  return stack.resolutionCache;
}

function isSameFrame(a: ResolutionFrame, b: ResolutionFrame): boolean {
  return a.token === b.token && a.key === b.key;
}

function formatFrame(frame: ResolutionFrame): string {
  return `${tokenLabel(frame.token)}${frame.key !== undefined ? `(${keyLabel(frame.key)})` : ""}`;
}

function getGlobalCache(): Map<unknown, unknown> {
  const store = globalThis as unknown as Record<string | symbol, unknown>;
  const existing = store[GLOBAL_CACHE_KEY] as Map<unknown, unknown> | undefined;
  if (existing) return existing;
  const created = new Map<string, unknown>();
  store[GLOBAL_CACHE_KEY] = created;
  return created;
}

function getGlobalPromiseCache(): Map<unknown, Promise<unknown>> {
  const store = globalThis as unknown as Record<string | symbol, unknown>;
  const existing = store[GLOBAL_PROMISE_CACHE_KEY] as
    | Map<unknown, Promise<unknown>>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, Promise<unknown>>();
  store[GLOBAL_PROMISE_CACHE_KEY] = created;
  return created;
}

function throwDisposalErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Multiple errors occurred during disposal.",
    );
  }
}

function getGlobalIdentityStore(): GlobalIdentityStore {
  const store = globalThis as unknown as Record<string | symbol, unknown>;
  const existing = store[GLOBAL_IDENTITY_KEY] as
    | GlobalIdentityStore
    | undefined;
  if (existing) {
    if (!existing.disposers) existing.disposers = new Map();
    return existing;
  }
  const created: GlobalIdentityStore = {
    explicit: new Map(),
    keyed: new Map(),
    disposers: new Map(),
  };
  store[GLOBAL_IDENTITY_KEY] = created;
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
  if (isDelayedToken(token)) return "delayed constructor";
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

function effectiveDisposal(descriptor: ServiceDescriptor): string {
  if (descriptor.disposal) return descriptor.disposal;
  return descriptor.lifetime === ServiceLifetime.Singleton ||
    descriptor.lifetime === ServiceLifetime.ContainerScoped
    ? "provider"
    : "none";
}
/* c8 ignore stop */
