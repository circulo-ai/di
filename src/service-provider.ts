import { ServiceLifetime } from "./lifetime";
import type {
  MaybeDisposable,
  Diagnostic,
  DiagnosticLevel,
  ServiceDescriptor,
  ServiceKey,
  ServiceResolver,
  Token,
} from "./types";
import { ServiceScope } from "./service-scope";

export class ServiceProvider implements ServiceResolver {
  private readonly descriptors: Map<Token, ServiceDescriptor[]>;
  private singletons = new WeakMap<ServiceDescriptor, unknown>();
  private readonly singletonDescriptors = new Set<ServiceDescriptor>();

  constructor(descriptors: ServiceDescriptor[]) {
    const grouped = new Map<Token, ServiceDescriptor[]>();
    descriptors.forEach((d) => {
      const list = grouped.get(d.token) ?? [];
      list.push(d);
      grouped.set(d.token, list);
    });
    this.descriptors = grouped;
  }

  resolve<T>(token: Token<T>, key?: ServiceKey): T {
    return this.resolveInternal(token, null, key);
  }

  tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined {
    try {
      return this.resolveInternal(token, null, key);
    } catch {
      return undefined;
    }
  }

  resolveAll<T>(token: Token<T>): T[] {
    const descriptors = this.descriptors.get(token) as ServiceDescriptor<T>[] | undefined;
    if (!descriptors?.length) {
      return [];
    }
    return descriptors.map((d) => this.resolveDescriptor(d, null));
  }

  createScope(): ServiceScope {
    return new ServiceScope(this);
  }

  async dispose(): Promise<void> {
    const instances: unknown[] = [];
    for (const descriptor of this.singletonDescriptors) {
      const value = this.singletons.get(descriptor);
      if (value !== undefined) {
        instances.push(value);
      }
    }
    await disposeMany(instances);
    this.singletons = new WeakMap();
    this.singletonDescriptors.clear();
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

  validateGraph(options?: { throwOnError?: boolean }): Diagnostic[] {
    /* c8 ignore start */
    const diagnostics: Diagnostic[] = [];
    for (const [token, descriptors] of this.descriptors.entries()) {
      const keyed = new Map<ServiceKey | undefined, ServiceDescriptor[]>();
      for (const d of descriptors) {
        const key = d.key;
        const list = keyed.get(key) ?? [];
        list.push(d);
        keyed.set(key, list);
      }

      for (const [key, group] of keyed.entries()) {
        if (group.length <= 1) continue;
        const message =
          key === undefined
            ? `Multiple registrations for token ${tokenLabel(token)} without a key; resolve() will pick the last registration.`
            : `Multiple registrations for token ${tokenLabel(token)} with key ${keyLabel(key)}; resolution is ambiguous.`;
        const level: DiagnosticLevel = key === undefined ? "warning" : "error";
        diagnostics.push({ level, message, token, key });
      }
    }

    if (options?.throwOnError) {
      const firstError = diagnostics.find((d) => d.level === "error");
      if (firstError) {
        throw new Error(firstError.message);
      }
    }

    return diagnostics;
    /* c8 ignore stop */
  }

  resolveFromScope<T>(token: Token<T>, scope: ServiceScope, key?: ServiceKey): T {
    return this.resolveInternal(token, scope, key);
  }

  private resolveInternal<T>(
    token: Token<T>,
    scope: ServiceScope | null,
    key?: ServiceKey,
  ): T {
    const descriptor = this.pickDescriptor(token, key) as ServiceDescriptor<T> | undefined;
    if (!descriptor) {
      throw new Error(
        key === undefined
          ? `Service not registered: ${tokenLabel(token)}`
          : `Service not registered for token ${tokenLabel(token)} with key ${keyLabel(key)}`,
      );
    }

    return this.resolveDescriptor(descriptor, scope);
  }

  resolveDescriptor<T>(descriptor: ServiceDescriptor<T>, scope: ServiceScope | null): T {
    if (descriptor.lifetime === ServiceLifetime.Singleton) {
      const existing = this.singletons.get(descriptor);
      if (existing) return existing as T;
      const instance = descriptor.factory(this) as T;
      this.singletons.set(descriptor, instance);
      this.singletonDescriptors.add(descriptor);
      return instance;
    }

    if (descriptor.lifetime === ServiceLifetime.Scoped) {
      if (!scope) {
        throw new Error(
          `Cannot resolve scoped service ${tokenLabel(descriptor.token)} from root provider. Create a scope first.`,
        );
      }
      return scope.getOrCreate(descriptor);
    }

    return descriptor.factory(scope ?? this) as T;
  }

  private pickDescriptor<T>(token: Token<T>, key?: ServiceKey): ServiceDescriptor<T> | undefined {
    const descriptors = this.descriptors.get(token) as ServiceDescriptor<T>[] | undefined;
    if (!descriptors?.length) return undefined;
    if (key === undefined) {
      return descriptors[descriptors.length - 1];
    }
    return descriptors.find((d) => d.key === key);
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
    }
  }
  if (disposals.length) {
    await Promise.all(disposals);
  }
}

function getDisposeFn(service: unknown): (() => void | Promise<void>) | undefined {
  if (!service || (typeof service !== "object" && typeof service !== "function")) {
    return undefined;
  }
  const candidate = service as MaybeDisposable & Record<string, unknown>;
  if (typeof candidate.dispose === "function") return candidate.dispose.bind(service);
  if (typeof candidate.close === "function") return candidate.close.bind(service);
  if (typeof candidate.destroy === "function") return candidate.destroy.bind(service);
  return undefined;
}

/* istanbul ignore next */
/* c8 ignore start */
function tokenLabel(token: Token): string {
  if (typeof token === "string" || typeof token === "number" || typeof token === "symbol") {
    return String(token);
  }
  return token.name ?? "anonymous";
}

function keyLabel(key: ServiceKey): string {
  return typeof key === "symbol" ? key.toString() : String(key);
}
/* c8 ignore stop */
