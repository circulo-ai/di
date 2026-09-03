import { describe, expect, it, vi } from "vitest";
import {
  Container,
  Lifecycle,
  autoInjectable,
  container,
  delay,
  inject,
  injectAll,
  injectAllWithTransform,
  injectWithTransform,
  injectable,
  instanceCachingFactory,
  instancePerContainerCachingFactory,
  predicateAwareClassFactory,
  registry,
  scoped,
  singleton,
} from "../src";

function parameter(
  decorator: ParameterDecorator,
  target: Function,
  index: number,
): void {
  decorator(target, undefined, index);
}

describe("Tsyringe-compatible API", () => {
  it("supports parameter decorators and transforms without reflect-metadata", () => {
    const local = new Container();
    const valueToken = Symbol("value");
    const pluginToken = Symbol("plugin");
    const transform = {
      transform(value: number, prefix: string) {
        return `${prefix}${value}`;
      },
    };
    @injectable()
    class Consumer {
      constructor(
        @inject(valueToken) readonly value: number,
        @injectAll(pluginToken) readonly plugins: string[],
        @injectWithTransform(valueToken, transform, "value=")
        readonly transformed: string,
      ) {}
    }

    local.register(valueToken, { useValue: 7 });
    local.register(pluginToken, { useValue: "one" }, { multiple: true });
    local.register(pluginToken, { useValue: "two" }, { multiple: true });
    local.register(Consumer, Consumer);

    expect(local.resolve(Consumer)).toEqual({
      value: 7,
      plugins: ["one", "two"],
      transformed: "value=7",
    });
  });

  it("supports injectAllWithTransform and optional injectAll", () => {
    const local = new Container();
    const token = Symbol("items");
    class Consumer {
      constructor(
        readonly values: number[],
        readonly missing: unknown[],
      ) {}
    }
    parameter(
      injectAllWithTransform(token, (values: unknown[]) =>
        (values as number[]).map((value) => value * 2),
      ),
      Consumer,
      0,
    );
    parameter(injectAll(Symbol("missing"), { isOptional: true }), Consumer, 1);
    injectable()(Consumer);
    local.register(token, { useValue: 2 }, { multiple: true });
    local.register(Consumer, Consumer);

    expect(local.resolve(Consumer)).toEqual({ values: [4], missing: [] });
  });

  it("supports child containers and all lifecycle modes", () => {
    const root = new Container();
    const token = Symbol("token");
    let resolutionCalls = 0;
    root.register(
      token,
      {
        useFactory: () => ({ id: ++resolutionCalls }),
      },
      { lifecycle: Lifecycle.ResolutionScoped },
    );

    class UsesTwice {
      constructor(
        readonly first: unknown,
        readonly second: unknown,
      ) {}
    }
    root.register(UsesTwice, {
      useFactory: (current) =>
        new UsesTwice(current.resolve(token), current.resolve(token)),
    });
    const result = root.resolve(UsesTwice);
    expect(result.first).toBe(result.second);

    root.register("root", { useValue: "root" });
    const child = root.createChildContainer();
    child.register("root", { useValue: "child" });
    expect(child.resolve("root")).toBe("child");
    expect(child.isRegistered("root")).toBe(true);
    expect(child.isRegistered(token, true)).toBe(true);
    expect(root.resolve("root")).toBe("root");
  });

  it("supports factories, registration aliases, reset, and clearInstances", () => {
    const local = new Container();
    const source = Symbol("source");
    const alias = Symbol("alias");
    let creates = 0;
    local.register(
      source,
      {
        useFactory: () => ({ id: ++creates }),
      },
      { lifecycle: Lifecycle.Singleton },
    );
    local.registerType(alias, source);
    expect(local.resolve(alias)).toBe(local.resolve(alias));

    const cached = instanceCachingFactory(() => ({ id: 1 }));
    expect(cached(local)).toBe(cached(local));
    const perContainer = instancePerContainerCachingFactory(() => ({}));
    expect(perContainer(local)).toBe(perContainer(local));
    expect(perContainer(local.createChildContainer())).not.toBe(
      perContainer(local),
    );

    class A {}
    class B {}
    let useA = true;
    const choose = predicateAwareClassFactory(() => useA, A, B, false);
    expect(choose(local)).toBeInstanceOf(A);
    useA = false;
    expect(choose(local)).toBeInstanceOf(B);

    local.clearInstances();
    expect(local.resolve(alias)).toBe(local.resolve(alias));
    local.reset();
    expect(local.isRegistered(source)).toBe(false);
  });

  it("supports delayed circular references", () => {
    const local = new Container();
    class Foo {
      constructor(readonly bar: Bar) {}
    }
    class Bar {
      constructor(readonly foo: Foo) {}
    }
    parameter(inject(delay(() => Bar)), Foo, 0);
    parameter(inject(delay(() => Foo)), Bar, 0);
    injectable()(Foo);
    injectable()(Bar);
    local.register(Foo, Foo, { lifecycle: Lifecycle.Singleton });
    local.register(Bar, Bar, { lifecycle: Lifecycle.Singleton });

    const foo = local.resolve(Foo);
    expect(foo.bar).toBeInstanceOf(Bar);
  });

  it("supports decorators, registry, and resolution interceptors", () => {
    const local = new Container();
    const before = vi.fn();
    const after = vi.fn();
    local.register("value", { useValue: 1 });
    local.beforeResolution("value", before, { frequency: "Once" });
    local.afterResolution("value", after, { frequency: "Once" });
    expect(local.resolve("value")).toBe(1);
    expect(local.resolve("value")).toBe(1);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);

    local.reset();
    registry([{ token: "registry", useValue: "registered" }])(class Marker {});
    expect(container.resolve("registry")).toBe("registered");
    container.reset();

    class GlobalSingleton {}
    singleton(GlobalSingleton);
    expect(container.resolve(GlobalSingleton)).toBe(
      container.resolve(GlobalSingleton),
    );
    container.reset();

    class ScopedValue {}
    scoped(Lifecycle.ContainerScoped)(ScopedValue);
    expect(container.resolve(ScopedValue)).toBe(container.resolve(ScopedValue));
    container.reset();

    class Auto {
      constructor(readonly value: number) {}
    }
    parameter(inject("auto"), Auto, 0);
    injectable()(Auto);
    container.register("auto", { useValue: 42 });
    const AutoResolved = autoInjectable()(Auto);
    expect(new AutoResolved().value).toBe(42);
    container.reset();
  });
});
