import { describe, it, expect, vi } from "vitest";
import {
  ServiceCollection,
  ServiceLifetime,
  resolveFromContext,
  tryResolveFromContext,
  createContainerMiddleware,
} from "../src";

const random = () => Math.random();

describe("Service lifetimes", () => {
  it("reuses singleton and disposes once", async () => {
    const dispose = vi.fn();
    const instance = { value: random(), dispose };
    const services = new ServiceCollection().addSingleton("Singleton", instance);
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

describe("Resolution helpers", () => {
  it("throws on missing, tryResolve returns undefined", () => {
    const services = new ServiceCollection();
    const provider = services.build();
    expect(() => provider.resolve("Missing")).toThrow();
    expect(provider.tryResolve("Missing")).toBeUndefined();
    expect(provider.resolveAll("Missing")).toEqual([]);
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
    expect(provider.resolve("Handler")).toBe("c"); // last wins without key
    expect(provider.resolve("Handler", "b")).toBe("b");
    expect(provider.tryResolve("Handler", "missing")).toBeUndefined();
    expect(provider.getDescriptors("Handler")?.length).toBe(3);
    expect(provider.getDescriptor("Handler")?.key).toBe("c");
  });

  it("supports multiple singleton registrations with keys", () => {
    const services = new ServiceCollection()
      .addSingleton("Repo", { name: "main" }, { multiple: true, key: "main" })
      .addSingleton("Repo", { name: "shadow" }, { multiple: true, key: "shadow" });
    const provider = services.build();
    const main = provider.resolve<{ name: string }>("Repo", "main");
    expect(main.name).toBe("main");
    const names = provider.resolveAll<{ name: string }>("Repo").map((r) => r.name);
    expect(names).toEqual(["main", "shadow"]);
  });

  it("resolveAll on scope returns [] when none and values when registered", () => {
    const services = new ServiceCollection().addScoped("Scoped", () => "scoped");
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
    expect(close).not.toHaveBeenCalled(); // dispose preferred
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
    const middleware = createContainerMiddleware(provider, { variableName: "scope" });
    const ctx = { var: {}, set: (k: string, v: unknown) => ((ctx.var as any)[k] = v) };
    await middleware(ctx as any, async () => {});
    const value = resolveFromContext<number>(ctx as any, "Value", "scope");
    expect(value).toBe(123);
  });
});

describe("Internals and guards", () => {
  it("wraps singleton factories and exposes descriptors", () => {
    const services = new ServiceCollection().addSingleton("Factory", () => ({ n: 1 }));
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
