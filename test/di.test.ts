import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  AsyncFactoryError,
  CircularDependencyError,
  MissingServiceError,
  ScopeResolutionError,
  ServiceCollection,
  ServiceLifetime,
  ServiceScope,
  bindToHono,
  createContainerMiddleware,
  createModule,
  createToken,
  decorateContext,
  factory,
  getGlobalProvider,
  ifDev,
  ifProd,
  ifTruthy,
  lazy,
  optional,
  resolveFromContext,
  tryResolveFromContext,
  useClass,
  useExisting,
  withRequestScope,
} from "../src";

const random = () => Math.random();

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------
describe("Service lifetimes", () => {
  it("reuses singleton and disposes once", async () => {
    const dispose = vi.fn();
    const instance = { value: random(), dispose };
    const services = new ServiceCollection().addSingleton(
      "Singleton",
      instance,
    );
    const provider = services.build();

    const a = provider.resolve<typeof instance>("Singleton");
    const b = provider.resolve<typeof instance>("Singleton");
    expect(a).toBe(b);

    await provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("caches scoped per scope", () => {
    const services = new ServiceCollection().addScoped("Scoped", () => ({
      value: random(),
    }));
    const provider = services.build();

    const scope1 = provider.createScope();
    const scope2 = provider.createScope();

    const a1 = scope1.resolve<{ value: number }>("Scoped");
    const a2 = scope1.resolve<{ value: number }>("Scoped");
    const b1 = scope2.resolve<{ value: number }>("Scoped");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it("creates transient every time", () => {
    const services = new ServiceCollection().addTransient("Transient", () => ({
      value: random(),
    }));
    const provider = services.build();

    const a = provider.resolve<{ value: number }>("Transient");
    const b = provider.resolve<{ value: number }>("Transient");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Resolution helpers & diagnostics
// ---------------------------------------------------------------------------
describe("Resolution helpers", () => {
  it("throws on missing, tryResolve returns undefined", () => {
    const services = new ServiceCollection();
    const provider = services.build();
    expect(() => provider.resolve("Missing")).toThrow();
    expect(provider.tryResolve("Missing")).toBeUndefined();
    expect(provider.resolveAll("Missing")).toEqual([]);
  });

  it("tryResolveAsync returns undefined for missing", async () => {
    const services = new ServiceCollection();
    const provider = services.build();
    await expect(provider.tryResolveAsync("Missing")).resolves.toBeUndefined();
  });

  it("tryResolve returns undefined when scoped resolved from root", () => {
    const services = new ServiceCollection().addScoped("Scoped", () => ({}));
    const provider = services.build();
    expect(provider.tryResolve("Scoped")).toBeUndefined();
  });

  it("has reports registrations", () => {
    const services = new ServiceCollection().addSingleton("Thing", {});
    const provider = services.build();
    expect(provider.has("Thing")).toBe(true);
    expect(provider.has("Other")).toBe(false);
  });

  it("fails resolving scoped from root", () => {
    const services = new ServiceCollection().addScoped("Scoped", () => ({}));
    const provider = services.build();
    expect(() => provider.resolve("Scoped")).toThrow();
  });

  it("resolves multiple and keyed registrations", () => {
    const services = new ServiceCollection()
      .addTransient("Handler", () => "a", { multiple: true })
      .addTransient("Handler", () => "b", { multiple: true, key: "b" })
      .addTransient("Handler", () => "c", { multiple: true, key: "c" });

    const provider = services.build();
    expect(provider.resolveAll("Handler")).toEqual(["a", "b", "c"]);
    expect(provider.resolve("Handler")).toBe("c");
    expect(provider.resolve("Handler", "b")).toBe("b");
    expect(provider.tryResolve("Handler", "missing")).toBeUndefined();
    expect(provider.getDescriptors("Handler")?.length).toBe(3);
    expect(provider.getDescriptor("Handler")?.key).toBe("c");
  });

  it("supports multiple singleton registrations with keys", () => {
    const services = new ServiceCollection()
      .addSingleton("Repo", { name: "main" }, { multiple: true, key: "main" })
      .addSingleton(
        "Repo",
        { name: "shadow" },
        { multiple: true, key: "shadow" },
      );
    const provider = services.build();
    const main = provider.resolve<{ name: string }>("Repo", "main");
    expect(main.name).toBe("main");
    const names = provider
      .resolveAll<{ name: string }>("Repo")
      .map((r) => r.name);
    expect(names).toEqual(["main", "shadow"]);
  });

  it("returns diagnostics for duplicate keyed registrations", () => {
    const services = new ServiceCollection()
      .addSingleton("Svc", () => "a", { multiple: true, key: "dup" })
      .addSingleton("Svc", () => "b", { multiple: true, key: "dup" });
    const provider = services.build();
    const diagnostics = provider.validateGraph();
    expect(diagnostics.some((d) => d.level === "error")).toBe(true);
    expect(() => provider.validateGraph({ throwOnError: true })).toThrow();
  });

  it("returns warning diagnostics for multiple registrations without keys", () => {
    const services = new ServiceCollection()
      .addTransient("X", () => "a", { multiple: true })
      .addTransient("X", () => "b", { multiple: true });
    const provider = services.build();
    const diagnostics = provider.validateGraph();
    expect(diagnostics.some((d) => d.level === "warning")).toBe(true);
  });

  it("does not throw when throwOnError is true and only warnings exist", () => {
    const services = new ServiceCollection()
      .addTransient("Warn", () => "a", { multiple: true })
      .addTransient("Warn", () => "b", { multiple: true });
    const provider = services.build();
    expect(() => provider.validateGraph({ throwOnError: true })).not.toThrow();
  });

  it("formats missing keyed resolution errors clearly", () => {
    const key = Symbol("k");
    const provider = new ServiceCollection().build();
    expect(() => provider.resolve("Missing", key)).toThrow(/key/);
  });

  it("formats class token names in errors", () => {
    class Foo {}
    const provider = new ServiceCollection().build();
    expect(() => provider.resolve(Foo)).toThrow(/Foo/);
  });

  it("resolveAll on scope returns [] when none and values when registered", () => {
    const services = new ServiceCollection().addScoped(
      "Scoped",
      () => "scoped",
    );
    const provider = services.build();
    const scope = provider.createScope();
    expect(scope.resolveAll("Missing")).toEqual([]);
    expect(scope.resolveAll("Scoped")).toEqual(["scoped"]);
    expect(scope.activeCount).toBe(1);
  });

  it("supports multiple scoped registrations", () => {
    const services = new ServiceCollection()
      .addScoped("Scoped", () => "one", { multiple: true })
      .addScoped("Scoped", () => "two", { multiple: true, key: "two" });
    const provider = services.build();
    const scope = provider.createScope();
    expect(scope.resolveAll("Scoped")).toEqual(["one", "two"]);
    expect(scope.resolve("Scoped", "two")).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// Disposal semantics
// ---------------------------------------------------------------------------
describe("Disposal semantics", () => {
  it("disposes scoped services on scope dispose", async () => {
    const dispose = vi.fn();
    const services = new ServiceCollection().addScoped("Disposable", () => ({
      dispose,
    }));
    const provider = services.build();
    const scope = provider.createScope();
    scope.resolve("Disposable");
    await scope.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("supports close/destroy and async dispose", async () => {
    const close = vi.fn();
    const destroy = vi.fn();
    const asyncDispose = vi.fn().mockResolvedValue(undefined);

    const services = new ServiceCollection().addSingleton("Combo", {
      close,
      destroy,
      dispose: asyncDispose,
    });
    const provider = services.build();
    provider.resolve("Combo");
    await provider.dispose();

    expect(asyncDispose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("falls back to close and destroy when dispose missing", async () => {
    const close = vi.fn();
    const destroy = vi.fn();
    const services = new ServiceCollection()
      .addSingleton("Closer", { close })
      .addSingleton("Destroyer", { destroy });
    const provider = services.build();
    provider.resolve("Closer");
    provider.resolve("Destroyer");
    await provider.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-object disposables", async () => {
    const services = new ServiceCollection().addSingleton("Number", 42);
    const provider = services.build();
    provider.resolve("Number");
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("ignores objects without dispose/close/destroy", async () => {
    const services = new ServiceCollection().addSingleton("Plain", {});
    const provider = services.build();
    provider.resolve("Plain");
    await provider.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hono helpers (container middleware and bindToHono)
// ---------------------------------------------------------------------------
describe("Hono helpers", () => {
  it("attaches scope per request and resolves/tries correctly", async () => {
    const dispose = vi.fn();
    const services = new ServiceCollection()
      .addScoped("RequestId", () => "req-" + random())
      .addTransient("Transient", () => ({ n: random() }))
      .addScoped("Disposable", () => ({ dispose }));
    const provider = services.build();
    const middleware = createContainerMiddleware(provider);

    const fakeContext = () => {
      const vars: Record<string, unknown> = {};
      return {
        var: vars,
        set: (k: string, v: unknown) => {
          (vars as any)[k] = v;
        },
      };
    };

    const ctx = fakeContext();
    const next = vi.fn(async () => {
      const container = (ctx as any).var.container;
      container.resolve("Disposable");
    });
    await middleware(ctx as any, next);
    expect(next).toHaveBeenCalled();

    const requestId = resolveFromContext<string>(ctx as any, "RequestId");
    expect(requestId).toMatch(/^req-/);
    const missing = tryResolveFromContext<string>(ctx as any, "Nope");
    expect(missing).toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when container is missing", () => {
    const ctx = { var: {}, set: () => {} };
    expect(tryResolveFromContext(ctx as any, "Anything")).toBeUndefined();
  });

  it("throws when resolving without container", () => {
    const ctx = { var: {}, set: () => {} };
    expect(() => resolveFromContext(ctx as any, "X")).toThrow();
  });

  it("supports custom variable name", async () => {
    const services = new ServiceCollection().addScoped("Value", () => 123);
    const provider = services.build();
    const middleware = createContainerMiddleware(provider, {
      variableName: "scope",
    });
    const ctx = {
      var: {},
      set: (k: string, v: unknown) => ((ctx.var as any)[k] = v),
    };
    await middleware(ctx as any, async () => {});
    const value = resolveFromContext<number>(ctx as any, "Value", "scope");
    expect(value).toBe(123);
  });

  it("bindToHono strict proxy resolves registered tokens", async () => {
    const TYPES = { Value: createToken<number>("value") };
    const services = new ServiceCollection().addScoped(TYPES.Value, () => 7);
    const provider = services.build();
    const app = new Hono();
    bindToHono(app as any, provider, TYPES, { cache: true, strict: true });
    app.get("/", (c) => {
      const di = (c as any).di as { Value: number };
      return c.json({ value: di.Value });
    });

    const res = await app.request("http://localhost/");
    const body = await res.json();
    expect(body.value).toBe(7);
  });

  it("bindToHono strict proxy throws on missing token", async () => {
    const TYPES = { Missing: createToken<string>("missing") };
    const services = new ServiceCollection();
    const provider = services.build();
    const app = new Hono();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bindToHono(app as any, provider, TYPES, { strict: true });
    app.get("/", (c) => {
      const di = (c as any).di as { Missing: string };
      return c.json({ value: di.Missing });
    });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });

  it("decorateContext attaches resolved services to c.var", async () => {
    const TYPES = { Num: createToken<number>("num") };
    const services = new ServiceCollection().addScoped(TYPES.Num, () => 3);
    const provider = services.build();
    const app = new Hono();
    bindToHono(app as any, provider, TYPES);
    app.use("*", decorateContext(TYPES, { targetVar: "svc" }) as any);
    app.get("/", (c) => {
      return c.json({ num: (c.var as any).svc.Num });
    });
    const res = await app.request("http://localhost/");
    const body = await res.json();
    expect(body.num).toBe(3);
  });

  it("createContextDiProxy throws when container missing", async () => {
    const TYPES = { X: createToken<number>("x") };
    const middleware = bindToHono; // ensure tree-shaking avoids unused import
    expect(middleware).toBeDefined();
    const proxy = (
      await import("../src/integration/hono")
    ).createContextDiProxy(TYPES, {
      strict: true,
    });
    const ctx = { var: {}, set: () => {} };
    await expect(proxy(ctx as any, async () => {})).rejects.toThrow(
      /container is missing/,
    );
  });

  it("caches proxy lookups when cache is enabled", async () => {
    const calls: number[] = [];
    const services = new ServiceCollection().addSingleton("Cached", () => {
      calls.push(1);
      return Math.random();
    });
    const provider = services.build();
    const proxyMw = (
      await import("../src/integration/hono")
    ).createContextDiProxy({ Cached: "Cached" as any }, { cache: true });
    const scope = provider.createScope();
    const ctx: any = {
      var: { container: scope },
      set: (k: string, v: unknown) => ((ctx.var as any)[k] = v),
    };
    await proxyMw(ctx, async () => {});
    const di = (ctx as any).di as { Cached: number };
    const first = di.Cached;
    const second = di.Cached;
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    await scope.dispose();
  });

  it("returns undefined for unknown or symbol properties on proxy", async () => {
    const services = new ServiceCollection().addSingleton("Value", 5);
    const provider = services.build();
    const proxyMw = (
      await import("../src/integration/hono")
    ).createContextDiProxy({
      Value: "Value" as any,
    });
    const scope = provider.createScope();
    const ctx: any = {
      var: { container: scope },
      set: (k: string, v: unknown) => ((ctx.var as any)[k] = v),
    };
    await proxyMw(ctx, async () => {});
    const di = (ctx as any).di as any;
    expect(di[Symbol.toStringTag]).toBeUndefined();
    expect(di.Missing).toBeUndefined();
    await scope.dispose();
  });

  it("throws when token map omits a property", async () => {
    const tokens = { Missing: undefined as any };
    const services = new ServiceCollection().addSingleton("Any", 1);
    const provider = services.build();
    const mw = (await import("../src/integration/hono")).createContextDiProxy(
      tokens,
    );
    const scope = provider.createScope();
    const ctx: any = { var: { container: scope }, set: () => {} };
    await mw(ctx, async () => {});
    expect(() => (ctx as any).di.Missing).toThrow(
      /Service token not registered/,
    );
    await scope.dispose();
  });

  it("decorateContext throws when container missing", async () => {
    const mw = decorateContext({ Num: createToken<number>("num") });
    const ctx: any = { var: {}, set: () => {} };
    await expect(mw(ctx, async () => {})).rejects.toThrow(
      /container is missing/,
    );
  });
});

// ---------------------------------------------------------------------------
// Internals and guards
// ---------------------------------------------------------------------------
describe("Internals and guards", () => {
  it("wraps singleton factories and exposes descriptors", () => {
    const services = new ServiceCollection().addSingleton("Factory", () => ({
      n: 1,
    }));
    const provider = services.build();
    const descriptor = provider.getDescriptor("Factory");
    expect(descriptor?.lifetime).toBe(ServiceLifetime.Singleton);
    expect(provider.resolve<{ n: number }>("Factory").n).toBe(1);
    expect(provider.getDescriptors("Factory")?.length).toBe(1);
  });

  it("validates scoped descriptor in getOrCreate", () => {
    const services = new ServiceCollection().addTransient("X", () => ({}));
    const provider = services.build();
    const scope = provider.createScope();
    const descriptor = provider.getDescriptor("X")!;
    expect(() => scope.getOrCreate(descriptor as any)).toThrow();
  });

  it("ignores repeated dispose calls on scope", async () => {
    const services = new ServiceCollection().addScoped("Item", () => ({
      dispose: vi.fn(),
    }));
    const provider = services.build();
    const scope = provider.createScope();
    scope.resolve("Item");
    await scope.dispose();
    await expect(scope.dispose()).resolves.toBeUndefined();
  });

  it("exposes service collection introspection", () => {
    const services = new ServiceCollection()
      .addSingleton("A", {})
      .addTransient("B", () => ({}), { multiple: true });
    expect(services.count).toBe(2);
    expect(services.tokens).toContain("A");
  });
});

// ---------------------------------------------------------------------------
// Async factories & advanced features
// ---------------------------------------------------------------------------
describe("async factories & resolveAsync", () => {
  it("reuses in-flight async singleton and throws on sync resolve", async () => {
    const calls: string[] = [];
    const services = new ServiceCollection();
    services.addSingleton("Async", async () => {
      calls.push("build");
      return { id: "value" };
    });
    const provider = services.build();

    const promise = provider.resolveAsync("Async");
    await expect(() => provider.resolve("Async")).toThrow(AsyncFactoryError);
    await Promise.all([promise, provider.resolveAsync("Async")]);
    expect(calls).toHaveLength(1);
    expect(provider.resolve("Async")).toEqual({ id: "value" });
  });
});

describe("disposal hooks", () => {
  it("runs scoped disposables and provider onDispose callbacks", async () => {
    const disposed: string[] = [];
    const services = new ServiceCollection();
    services.addScoped("Disposable", () => ({
      dispose: () => disposed.push("dispose"),
    }));
    const provider = services.build();
    provider.onDispose(() => {
      disposed.push("provider");
    });

    await provider.withScope(async (scope) => {
      scope.resolve("Disposable");
    });
    await provider.dispose();

    expect(disposed).toEqual(["dispose", "provider"]);
  });
});

describe("global singleton", () => {
  it("reuses instance across providers", async () => {
    const token = createToken<{ id: number }>("global");
    const services1 = new ServiceCollection().addGlobalSingleton(token, {
      id: 1,
    });
    const services2 = new ServiceCollection().addGlobalSingleton(token, {
      id: 2,
    });
    const first = services1.build().resolve(token);
    const second = services2.build().resolve(token);
    expect(second.id).toBe(first.id);
    const cacheKey = Symbol.for("@circulo-ai/di:globals");
    const cache = (globalThis as any)[cacheKey] as Map<string, unknown>;
    cache?.clear();
  });

  it("supports keyed global singletons", () => {
    const token = createToken<string>("keyed-global");
    const services = new ServiceCollection()
      .addGlobalSingleton(token, "a", { key: "alpha", multiple: true })
      .addGlobalSingleton(token, "b", { key: "beta", multiple: true });
    const provider = services.build();
    expect(provider.resolve(token, "alpha")).toBe("a");
    expect(provider.resolve(token, "beta")).toBe("b");
    const cacheKey = Symbol.for("@circulo-ai/di:globals");
    const cache = (globalThis as any)[cacheKey] as Map<string, unknown>;
    cache?.clear();
  });
});

describe("withScope helper", () => {
  it("auto-disposes scope", async () => {
    const disposed: string[] = [];
    const services = new ServiceCollection().addScoped("Thing", () => ({
      destroy: () => disposed.push("destroy"),
    }));
    const provider = services.build();
    await provider.withScope(async (scope) => {
      scope.resolve("Thing");
    });
    expect(disposed).toEqual(["destroy"]);
  });
});

describe("token helpers", () => {
  it("creates typed tokens and optional resolves to undefined", () => {
    const token = createToken<number>("num");
    const services = new ServiceCollection();
    services.addSingleton(token, 42);
    const provider = services.build();
    expect(provider.resolve(token)).toBe(42);
    expect(provider.resolve(optional(createToken("missing")))).toBeUndefined();
  });

  it("creates tokens without explicit name", () => {
    const unnamed = createToken<number>();
    const services = new ServiceCollection().addSingleton(unnamed, 7);
    const provider = services.build();
    expect(provider.resolve(unnamed)).toBe(7);
  });
});

describe("keyed resolution map", () => {
  it("returns keyed object and errors on unkeyed", () => {
    const services = new ServiceCollection();
    services.addSingleton("Cache", () => "A", { key: "a", multiple: true });
    services.addSingleton("Cache", () => "B", { key: "b", multiple: true });
    const provider = services.build();
    expect(provider.resolveMap("Cache")).toMatchObject({ a: "A", b: "B" });

    const conflict = new ServiceCollection();
    conflict.addSingleton("X", () => "one", { multiple: true });
    conflict.addSingleton("X", () => "two", { multiple: true });
    const conflictProvider = conflict.build();
    expect(() => conflictProvider.resolveMap("X")).toThrow();
  });

  it("throws on duplicate keyed registrations", () => {
    const services = new ServiceCollection();
    services.addSingleton("Cache", () => "A", { key: "dup", multiple: true });
    services.addSingleton("Cache", () => "B", { key: "dup", multiple: true });
    const provider = services.build();
    expect(() => provider.resolveMap("Cache")).toThrow(/Duplicate key/);
  });

  it("returns empty object when nothing registered", () => {
    const provider = new ServiceCollection().build();
    expect(provider.resolveMap("Missing")).toEqual({});
  });
});

describe("circular detection", () => {
  it("throws circular dependency error", () => {
    const services = new ServiceCollection();
    services.addTransient("A", (r) => r.resolve("B"));
    services.addTransient("B", (r) => r.resolve("A"));
    const provider = services.build();
    expect(() => provider.resolve("A")).toThrow(CircularDependencyError);
  });
});

describe("validateGraph", () => {
  it("flags duplicate unkeyed registrations", () => {
    const services = new ServiceCollection();
    services.addSingleton("Dup", () => ({}), { multiple: true });
    services.addSingleton("Dup", () => ({}), { multiple: true });
    const diagnostics = services.build().validateGraph();
    expect(
      diagnostics.some((d) => d.level === "error" || d.level === "warning"),
    ).toBe(true);
  });

  it("warns on mixed keyed/unkeyed and unused tokens", () => {
    const MIXED = createToken<string>("mixed");
    const UNUSED = createToken("unused");
    const services = new ServiceCollection({ defaultMultiple: true });
    services.addTransient(MIXED, () => "base");
    services.addTransient(MIXED, () => "keyed", { key: "k" });
    const diagnostics = services
      .build()
      .validateGraph({ unusedTokens: [UNUSED] });
    expect(diagnostics.some((d) => d.message.includes("mixes keyed"))).toBe(
      true,
    );
    expect(diagnostics.some((d) => d.message.includes("Unused token"))).toBe(
      true,
    );
  });

  it("enforces requireKeysForMultiple when requested", () => {
    const services = new ServiceCollection();
    services.addTransient("NoKey", () => "a", { multiple: true });
    services.addTransient("NoKey", () => "b", { multiple: true });
    const diagnostics = services
      .build()
      .validateGraph({ requireKeysForMultiple: true });
    expect(diagnostics.some((d) => d.level === "error")).toBe(true);
  });
});

describe("disposal priority & order", () => {
  it("disposes scoped in reverse order with priority", async () => {
    const order: string[] = [];
    const services = new ServiceCollection();
    services.addScoped(
      "First",
      () => ({
        dispose: () => order.push("first"),
      }),
      { disposePriority: 1 },
    );
    services.addScoped(
      "Second",
      () => ({
        dispose: () => order.push("second"),
      }),
      { disposePriority: 2 },
    );
    const provider = services.build();
    await provider.withScope(async (scope) => {
      scope.resolve("First");
      scope.resolve("Second");
    });
    expect(order).toEqual(["second", "first"]);
  });

  it("falls back to resolution order when scoped priorities match", async () => {
    const order: string[] = [];
    const services = new ServiceCollection();
    services.addScoped("One", () => ({ dispose: () => order.push("one") }));
    services.addScoped("Two", () => ({ dispose: () => order.push("two") }));
    const provider = services.build();
    await provider.withScope(async (scope) => {
      scope.resolve("One");
      scope.resolve("Two");
    });
    expect(order).toEqual(["two", "one"]);
  });

  it("orders singleton disposals by priority", async () => {
    const order: string[] = [];
    const services = new ServiceCollection();
    services.addSingleton(
      "Low",
      { dispose: () => order.push("low") },
      { disposePriority: 1 },
    );
    services.addSingleton(
      "High",
      { dispose: () => order.push("high") },
      { disposePriority: 5 },
    );
    const provider = services.build();
    provider.resolve("Low");
    provider.resolve("High");
    await provider.dispose();
    expect(order).toEqual(["high", "low"]);
  });
});

describe("structured errors include token and path", () => {
  it("ScopeResolutionError carries token and path", () => {
    const services = new ServiceCollection();
    services.addScoped("Scoped", () => ({}));
    const provider = services.build();
    expect(() => provider.resolve("Scoped")).toThrow(ScopeResolutionError);
  });

  it("MissingServiceError carries token", () => {
    const provider = new ServiceCollection().build();
    try {
      provider.resolve("Missing");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MissingServiceError);
      expect(err.token).toBe("Missing");
    }
  });
});

describe("collection defaults and env helpers", () => {
  it("respects allowOverwrite=false", () => {
    const services = new ServiceCollection({ allowOverwrite: false });
    services.addSingleton("One", 1);
    expect(() => services.addSingleton("One", 2)).toThrow();
  });

  it("registers conditionally with ifTruthy", () => {
    process.env.ENABLE_FEATURE = "1";
    const services = new ServiceCollection();
    ifTruthy(services, "ENABLE_FEATURE", (s) =>
      s.addSingleton("Flagged", "on"),
    );
    const provider = services.build();
    expect(provider.resolve("Flagged")).toBe("on");

    delete process.env.ENABLE_FEATURE;
    const services2 = new ServiceCollection();
    ifTruthy(services2, "ENABLE_FEATURE", (s) =>
      s.addSingleton("Flagged", "on"),
    );
    const provider2 = services2.build();
    expect(provider2.tryResolve("Flagged")).toBeUndefined();
  });

  it("registers only in prod/dev via ifProd/ifDev", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const prodServices = new ServiceCollection();
    ifProd(prodServices, (s) => s.addSingleton("ProdOnly", "yes"));
    const prodProvider = prodServices.build();
    expect(prodProvider.resolve("ProdOnly")).toBe("yes");

    process.env.NODE_ENV = "development";
    const devServices = new ServiceCollection();
    ifDev(devServices, (s) => s.addSingleton("DevOnly", "ok"));
    const devProvider = devServices.build();
    expect(devProvider.resolve("DevOnly")).toBe("ok");

    process.env.NODE_ENV = original;
  });

  it("defaults NODE_ENV to development when unset", () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const services = new ServiceCollection();
    ifDev(services, (s) => s.addSingleton("DefaultEnv", "dev"));
    const provider = services.build();
    expect(provider.resolve("DefaultEnv")).toBe("dev");
    if (original !== undefined) {
      process.env.NODE_ENV = original;
    } else {
      delete process.env.NODE_ENV;
    }
  });
});

describe("factory and lazy helpers", () => {
  it("factory resolves on demand", () => {
    const services = new ServiceCollection();
    services.addSingleton("Value", 5);
    services.addTransient("Factory", factory("Value"));
    const provider = services.build();
    const f = provider.resolve<() => number>("Factory");
    expect(f()).toBe(5);
  });

  it("lazy memoizes per resolver", () => {
    const calls: number[] = [];
    const services = new ServiceCollection();
    services.addTransient("Value", () => {
      calls.push(1);
      return Math.random();
    });
    services.addScoped("Lazy", lazy("Value"));
    const provider = services.build();
    return provider.withScope(async (scope) => {
      const l = scope.resolve<() => number>("Lazy");
      const first = l();
      const second = l();
      expect(first).toBe(second);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("tracing hook", () => {
  it("captures resolve trace", () => {
    const events: any[] = [];
    const services = new ServiceCollection({
      trace: (event) => events.push(event),
    });
    services.addSingleton("X", () => 1);
    const provider = services.build();
    provider.resolve("X");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      token: "X",
      lifetime: ServiceLifetime.Singleton,
    });
  });

  it("includes keys in trace path", () => {
    const events: any[] = [];
    const services = new ServiceCollection({
      trace: (event) => events.push(event),
    });
    services.addTransient("Keyed", () => "v", { key: "k", multiple: true });
    const provider = services.build();
    provider.resolve("Keyed", "k");
    expect(events[0].path.some((p: string) => p.includes("(k)"))).toBe(true);
  });
});

describe("value provider with dispose", () => {
  it("calls custom dispose even when value is plain", async () => {
    const disposed: string[] = [];
    const services = new ServiceCollection();
    services.addSingleton("Plain", {
      value: 1,
      dispose: () => disposed.push("x"),
    });
    const provider = services.build();
    provider.resolve("Plain");
    await provider.dispose();
    expect(disposed).toEqual(["x"]);
  });
});

describe("ServiceCollection extras", () => {
  it("captures stack traces when enabled and uses close disposer from value provider", async () => {
    const close = vi.fn();
    const services = new ServiceCollection({ captureStack: true });
    services.addSingleton("Value", { value: 3, close });
    const provider = services.build();
    provider.resolve("Value");
    const descriptor = provider.getDescriptor("Value")!;
    expect(descriptor.source).toBeTruthy();
    await provider.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses destroy disposer from value providers", async () => {
    const destroy = vi.fn();
    const services = new ServiceCollection();
    services.addSingleton("Destroyable", { value: 8, destroy });
    const provider = services.build();
    provider.resolve("Destroyable");
    await provider.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("useExisting & useClass", () => {
  it("aliases tokens", () => {
    const Primary = createToken<number>("Primary");
    const Alias = createToken<number>("Alias");
    const services = new ServiceCollection();
    services.addSingleton(Primary, 10);
    useExisting(services, Alias, Primary);
    const provider = services.build();
    expect(provider.resolve(Alias)).toBe(10);
  });

  it("constructs classes", () => {
    class Foo {
      id = 7;
    }
    const FooToken = createToken<Foo>("Foo");
    const services = new ServiceCollection();
    useClass(services, FooToken, Foo);
    const provider = services.build();
    expect(provider.resolve(FooToken).id).toBe(7);
  });

  it("honors lifetime overrides for helpers", async () => {
    const Global = createToken<number>("Global");
    const Alias = createToken<number>("Alias");
    const Scoped = createToken<{ id: number }>("Scoped");
    const ScopedAlias = createToken<{ id: number }>("ScopedAlias");

    const services = new ServiceCollection();
    services.addGlobalSingleton(Global, 11);
    useExisting(services, Alias, Global, {
      lifetime: ServiceLifetime.GlobalSingleton,
    });
    services.addScoped(Scoped, () => ({ id: 1 }));
    useClass(
      services,
      ScopedAlias,
      class ScopedClass {
        id = 2;
      },
      { lifetime: ServiceLifetime.Scoped },
    );

    const provider = services.build();
    expect(provider.resolve(Alias)).toBe(11);

    const scope = provider.createScope();
    expect(scope.resolve(ScopedAlias).id).toBe(2);
    await scope.dispose();
    const globalKey = Symbol.for("@circulo-ai/di:globals");
    const cache = (globalThis as any)[globalKey] as Map<string, unknown>;
    cache?.clear();
  });
});

describe("edge async resolution paths", () => {
  it("deduplicates global async singletons and rejects sync resolve while pending", async () => {
    const token = createToken<number>("globalAsync");
    let calls = 0;
    const services = new ServiceCollection().addGlobalSingleton(
      token,
      async () => {
        calls += 1;
        return 99;
      },
    );
    const provider = services.build();
    const p1 = provider.resolveAsync(token);
    const p2 = provider.resolveAsync(token);
    await expect(() => provider.resolve(token)).toThrow(AsyncFactoryError);
    const [first, second] = await Promise.all([p1, p2]);
    expect(first).toBe(second);
    expect(first).toBe(99);
    expect(await provider.resolveAsync(token)).toBe(99);
    expect(calls).toBe(1);
    const cache = (globalThis as any)[Symbol.for("@circulo-ai/di:globals")];
    cache?.clear();
  });

  it("guards scoped async resolves from root and supports transient async resolve", async () => {
    const services = new ServiceCollection()
      .addScoped("ScopedAsync", async () => "scoped")
      .addTransient("TransientAsync", () => "t");
    const provider = services.build();
    await expect(provider.resolveAsync("ScopedAsync")).rejects.toThrow(
      ScopeResolutionError,
    );
    expect(await provider.resolveAsync("TransientAsync")).toBe("t");
  });

  it("deduplicates pending scoped async and throws on sync resolve while pending", async () => {
    let calls = 0;
    const services = new ServiceCollection().addScoped(
      "AsyncScoped",
      async () => {
        calls += 1;
        return "value";
      },
    );
    const provider = services.build();
    const scope = provider.createScope();
    const p1 = scope.resolveAsync("AsyncScoped");
    const p2 = scope.resolveAsync("AsyncScoped");
    await expect(() => scope.resolve("AsyncScoped")).toThrow(AsyncFactoryError);
    const [first, second] = await Promise.all([p1, p2]);
    expect(first).toBe("value");
    expect(second).toBe("value");
    expect(scope.resolve("AsyncScoped")).toBe("value");
    expect(await scope.resolveAsync("AsyncScoped")).toBe("value");
    expect(calls).toBe(1);
    await scope.dispose();
  });

  it("throws when resolving async factories synchronously", () => {
    const services = new ServiceCollection().addTransient(
      "AsyncFactory",
      async () => "x",
    );
    const provider = services.build();
    expect(() => provider.resolve("AsyncFactory")).toThrow(AsyncFactoryError);
  });

  it("exposes resolver helper variants inside factories", async () => {
    const services = new ServiceCollection();
    services.addSingleton("Base", 1);
    services.addTransient("UsesResolver", async (resolver) => {
      const resolved = resolver.resolve("Base");
      const maybe = resolver.tryResolve("Missing");
      const resolvedAsync = await resolver.resolveAsync("Base");
      const maybeAsync = await resolver.tryResolveAsync("Missing");
      const all = resolver.resolveAll<number>("Base");
      return { resolved, maybe, resolvedAsync, maybeAsync, all };
    });
    const provider = services.build();
    const result = await provider.resolveAsync<{
      resolved: number;
      maybe?: number;
      resolvedAsync: number;
      maybeAsync?: number;
      all: number[];
    }>("UsesResolver");
    expect(result.resolved).toBe(1);
    expect(result.maybe).toBeUndefined();
    expect(result.resolvedAsync).toBe(1);
    expect(result.maybeAsync).toBeUndefined();
    expect(result.all).toEqual([1]);
  });
});

describe("binding DSL and modules", () => {
  it("binds values, functions, and classes with dependency objects", () => {
    class WithDeps {
      constructor(public deps: { bar: string; id: number }) {}
    }
    const services = new ServiceCollection();
    services.bind("Value").toValue(42);
    services.bind("Fn").toFunction(() => "fn");
    services.bind("Bar").toValue("bar");
    services.bind("Id").toValue(7);
    services
      .bind(WithDeps)
      .toClass(
        WithDeps,
        { bar: "Bar", id: "Id" },
        { lifetime: ServiceLifetime.Transient },
      );

    const provider = services.build();
    const scope = provider.createScope();

    expect(provider.resolve("Value")).toBe(42);
    expect(provider.resolve<() => string>("Fn")()).toBe("fn");
    const instance = scope.resolve(WithDeps);
    expect(instance.deps.bar).toBe("bar");
    expect(instance.deps.id).toBe(7);
  });

  it("supports scoped lifetime via scope alias", () => {
    const services = new ServiceCollection();
    services
      .bind("ScopedValue")
      .toFactory(() => ({ id: Math.random() }), { scope: "scoped" });
    const provider = services.build();
    const scope1 = provider.createScope();
    const scope2 = provider.createScope();
    const a = scope1.resolve<{ id: number }>("ScopedValue");
    const b = scope1.resolve<{ id: number }>("ScopedValue");
    const c = scope2.resolve<{ id: number }>("ScopedValue");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("resolves async higher-order bindings when async flag is set", async () => {
    const services = new ServiceCollection();
    services.addSingleton("AsyncDep", async () => "dep");
    services
      .bind("Ho")
      .toHigherOrderFunction((dep: string) => `${dep}!`, ["AsyncDep"], {
        async: true,
      });
    const provider = services.build();
    await expect(provider.resolveAsync("Ho")).resolves.toBe("dep!");
  });

  it("applies modules with binders", () => {
    const module = createModule();
    module.bind("Modded").toValue("mod");
    const services = new ServiceCollection().addModule(module);
    const provider = services.build();
    expect(provider.resolve("Modded")).toBe("mod");
  });
});

describe("next helpers", () => {
  it("reuses provider across calls with getGlobalProvider", () => {
    const key = Symbol("provider-key");
    const services = new ServiceCollection().addSingleton("Value", 1);
    const provider = getGlobalProvider(() => services.build(), key);
    const provider2 = getGlobalProvider(() => services.build(), key);
    expect(provider).toBe(provider2);
    expect(provider.resolve("Value")).toBe(1);
  });

  it("wraps handlers with per-request scopes", async () => {
    const services = new ServiceCollection();
    let disposed = 0;
    services.addScoped("Scoped", () => ({
      id: Math.random(),
      dispose: () => {
        disposed += 1;
      },
    }));
    const provider = services.build();

    const handler = withRequestScope<
      ServiceScope,
      { id: number },
      { params: Record<string, unknown> },
      { ok: boolean }
    >(provider, async (_req, ctx) => {
      const first = ctx.container.resolve<{ id: number }>("Scoped");
      const second = ctx.container.resolve<{ id: number }>("Scoped");
      expect(first).toBe(second);
      return { ok: true };
    });

    const result = await handler({ id: 1 }, { params: {} });
    expect((result as any).ok).toBe(true);
    expect(disposed).toBe(1);
  });
});

describe("service scope internals", () => {
  it("honors scoped dispose priorities and tryResolveAsync", async () => {
    const services = new ServiceCollection().addScoped("Scoped", () => ({}));
    const provider = services.build();
    const scope = provider.createScope();
    const order: string[] = [];
    scope.onDisposeWithPriority(() => {
      order.push("late");
    }, -1);
    scope.onDispose(() => {
      order.push("mid");
    });
    scope.onDisposeWithPriority(() => {
      order.push("first");
    }, 2);
    await expect(scope.tryResolveAsync("Missing")).resolves.toBeUndefined();
    await scope.dispose();
    expect(order).toEqual(["first", "mid", "late"]);
  });

  it("getOrCreate caches sync and rejects async scoped factories", () => {
    const services = new ServiceCollection();
    services.addScoped("SyncScoped", () => ({ id: 1 }));
    services.addScoped("AsyncScoped", async () => ({ id: 2 }));
    const provider = services.build();
    const scope = provider.createScope();
    const syncDescriptor = provider.getDescriptor("SyncScoped")!;
    const first = scope.getOrCreate(syncDescriptor);
    const second = scope.getOrCreate(syncDescriptor);
    expect(second).toBe(first);
    const asyncDescriptor = provider.getDescriptor("AsyncScoped")!;
    expect(() => scope.getOrCreate(asyncDescriptor)).toThrow(AsyncFactoryError);
  });
});

describe("dispose helpers", () => {
  it("invokes Symbol-based disposers and function disposers", async () => {
    const asyncSym = (Symbol as any).asyncDispose;
    const syncSym = (Symbol as any).dispose;

    const asyncDispose = vi.fn().mockResolvedValue(undefined);
    const syncDispose = vi.fn();
    const fnDispose = vi.fn().mockResolvedValue(undefined);

    const services = new ServiceCollection();
    services.addSingleton("AsyncSym", { [asyncSym]: asyncDispose });
    services.addSingleton("SyncSym", { [syncSym]: syncDispose });
    services.addSingleton("Fn", () => fnDispose);
    const provider = services.build();
    provider.resolve("AsyncSym");
    provider.resolve("SyncSym");
    provider.resolve("Fn");
    await provider.dispose();

    expect(asyncDispose).toHaveBeenCalled();
    expect(syncDispose).toHaveBeenCalled();
    expect(fnDispose).toHaveBeenCalled();
  });
});
