import { ServiceLifetime } from "../core/lifetime.js";
import type { ServiceProvider } from "../core/service-provider.js";
import type { ServiceKey, Token, TraceEvent } from "../core/types.js";

export type DependencyGraphTokenType =
  | "class"
  | "symbol"
  | "string"
  | "delayed"
  | "other";

export type DependencyGraphNode = {
  id: string;
  label: string;
  tokenType: DependencyGraphTokenType;
  key?: string;
  lifetime?: ServiceLifetime;
  resolutions: number;
  asyncResolutions: number;
  cycle: boolean;
};

export type DependencyGraphEdge = {
  id: string;
  source: string;
  target: string;
  resolutions: number;
  asyncResolutions: number;
};

export type DependencyGraphSnapshot = {
  version: 1;
  capturedAt: string;
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  roots: string[];
  cycles: string[][];
};

type GraphFrame = { token: Token; key?: ServiceKey };

/**
 * Collects the dependency edges observed while a provider resolves services.
 *
 * This is deliberately runtime instrumentation: the graph represents what
 * factories actually resolved, including dynamic and conditional lookups.
 * Use `ServiceCollection` descriptor dependencies or `validateGraph()` when a
 * static registration graph is required before the application starts.
 */
export class RuntimeDependencyGraph {
  private readonly tokenIds = new Map<Token, string>();
  private readonly keyIds = new Map<ServiceKey, string>();
  private readonly nodes = new Map<
    string,
    DependencyGraphNode & { token: Token; serviceKey?: ServiceKey }
  >();
  private readonly edges = new Map<string, DependencyGraphEdge>();
  private readonly roots = new Set<string>();
  private readonly cycles = new Map<string, string[]>();
  private nextTokenId = 1;
  private nextKeyId = 1;

  /** A bound callback, safe to pass as `trace: graph.record`. */
  readonly record = (event: TraceEvent): void => {
    const frames = event.pathEntries?.length
      ? event.pathEntries
      : event.path.map((label) => ({ token: label }));
    if (!frames.length) return;

    const ids = frames.map((frame) => this.ensureNode(frame));
    this.roots.add(ids[0]);

    const current = this.nodes.get(ids[ids.length - 1]);
    if (current) {
      current.resolutions += 1;
      if (event.async) current.asyncResolutions += 1;
      if (current.lifetime === undefined) current.lifetime = event.lifetime;
    }

    if (ids.length > 1) {
      const source = ids[ids.length - 2];
      const target = ids[ids.length - 1];
      const edgeId = `${source}->${target}`;
      const edge = this.edges.get(edgeId) ?? {
        id: edgeId,
        source,
        target,
        resolutions: 0,
        asyncResolutions: 0,
      };
      edge.resolutions += 1;
      if (event.async) edge.asyncResolutions += 1;
      this.edges.set(edgeId, edge);
    }

    const repeatedIndex = ids.findIndex((id, index) =>
      ids.slice(0, index).includes(id),
    );
    if (repeatedIndex >= 0) {
      const cycleStart = ids.indexOf(ids[repeatedIndex]);
      const cycle = ids.slice(cycleStart, repeatedIndex + 1);
      const cycleKey = [...new Set(cycle)].sort().join("|");
      this.cycles.set(cycleKey, cycle);
      for (const id of cycle) {
        const node = this.nodes.get(id);
        if (node) node.cycle = true;
      }
    }
  };

  /** Attach this recorder to a built provider and return an unsubscribe fn. */
  attach(provider: ServiceProvider): () => void {
    return provider.onTrace(this.record);
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.roots.clear();
    this.cycles.clear();
  }

  snapshot(): DependencyGraphSnapshot {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      nodes: [...this.nodes.values()].map(
        ({ token: _token, serviceKey: _key, ...node }) => ({
          ...node,
        }),
      ),
      edges: [...this.edges.values()].map((edge) => ({ ...edge })),
      roots: [...this.roots],
      cycles: [...this.cycles.values()].map((cycle) => [...cycle]),
    };
  }

  private ensureNode(frame: GraphFrame): string {
    const tokenId = this.tokenId(frame.token);
    const keyId = frame.key === undefined ? "none" : this.keyId(frame.key);
    const id = `${tokenId}:${keyId}`;
    if (this.nodes.has(id)) return id;

    this.nodes.set(id, {
      id,
      label: tokenLabel(frame.token),
      tokenType: tokenType(frame.token),
      key: frame.key === undefined ? undefined : keyLabel(frame.key),
      resolutions: 0,
      asyncResolutions: 0,
      cycle: false,
      token: frame.token,
      serviceKey: frame.key,
    });
    return id;
  }

  private tokenId(token: Token): string {
    const existing = this.tokenIds.get(token);
    if (existing) return existing;
    const id = `t${this.nextTokenId++}`;
    this.tokenIds.set(token, id);
    return id;
  }

  private keyId(key: ServiceKey): string {
    const existing = this.keyIds.get(key);
    if (existing) return existing;
    const id = `k${this.nextKeyId++}`;
    this.keyIds.set(key, id);
    return id;
  }
}

function tokenType(token: Token): DependencyGraphTokenType {
  if (typeof token === "string") return "string";
  if (typeof token === "symbol") return "symbol";
  if (typeof token === "function") return "class";
  if (typeof token === "object" && token !== null && "__delayed" in token) {
    return "delayed";
  }
  return "other";
}

function tokenLabel(token: Token): string {
  if (typeof token === "string") return token;
  if (typeof token === "symbol")
    return token.description ? `Symbol(${token.description})` : "Symbol";
  if (typeof token === "function") return token.name || "Anonymous class";
  if (
    typeof token === "object" &&
    token !== null &&
    "getConstructor" in token
  ) {
    try {
      return token.getConstructor().name || "Delayed constructor";
    } catch {
      return "Delayed constructor";
    }
  }
  return String(token);
}

function keyLabel(key: ServiceKey): string {
  return typeof key === "symbol"
    ? key.description
      ? `Symbol(${key.description})`
      : "Symbol"
    : String(key);
}
