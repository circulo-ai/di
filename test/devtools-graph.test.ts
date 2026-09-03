import { describe, expect, it } from "vitest";
import { ServiceCollection, ServiceLifetime } from "../src";
import {
  RuntimeDependencyGraph,
  renderDependencyGraphHtml,
} from "../src/devtools";

describe("runtime dependency graph devtools", () => {
  it("captures identity-safe runtime edges and resolution counts", () => {
    const graph = new RuntimeDependencyGraph();
    const services = new ServiceCollection();
    services.addSingleton("config", { enabled: true });
    services.addTransient("repository", (resolver) => ({
      config: resolver.resolve("config"),
    }));
    services.addTransient("application", (resolver) =>
      resolver.resolve("repository"),
    );
    const provider = services.build();
    const detach = graph.attach(provider);

    provider.resolve("application");
    provider.resolve("application");
    detach();

    const snapshot = graph.snapshot();
    const application = snapshot.nodes.find(
      (node) => node.label === "application",
    );
    const repository = snapshot.nodes.find(
      (node) => node.label === "repository",
    );
    const config = snapshot.nodes.find((node) => node.label === "config");
    expect(application?.lifetime).toBe(ServiceLifetime.Transient);
    expect(application?.resolutions).toBe(2);
    expect(repository?.resolutions).toBe(2);
    expect(config?.resolutions).toBe(2);
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: application?.id,
          target: repository?.id,
          resolutions: 2,
        }),
        expect.objectContaining({
          source: repository?.id,
          target: config?.id,
          resolutions: 2,
        }),
      ]),
    );
  });

  it("detects cycles in observed resolution paths", () => {
    const graph = new RuntimeDependencyGraph();
    const services = new ServiceCollection();
    services.addTransient("a", (resolver) => resolver.resolve("b"));
    services.addTransient("b", (resolver) => resolver.resolve("a"));
    const provider = services.build();
    graph.attach(provider);

    expect(() => provider.resolve("a")).toThrow();
    const snapshot = graph.snapshot();
    expect(snapshot.cycles.length).toBe(1);
    expect(
      snapshot.nodes.filter((node) => node.cycle).map((node) => node.label),
    ).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("renders a self-contained viewer document", () => {
    const snapshot = new RuntimeDependencyGraph().snapshot();
    const html = renderDependencyGraphHtml(snapshot, {
      title: "My runtime graph",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("My runtime graph");
    expect(html).toContain("const DATA =");
    expect(html).not.toContain("https://");
  });
});
