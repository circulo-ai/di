import type { ServiceKey, Token } from "./types";

type PathEntry = { token: Token; key?: ServiceKey };

export class MissingServiceError extends Error {
  constructor(
    message: string,
    public readonly token: Token,
    public readonly key?: ServiceKey,
    public readonly path: PathEntry[] = [],
  ) {
    super(message);
    this.name = "MissingServiceError";
  }
}

export class CircularDependencyError extends Error {
  constructor(
    message: string,
    public readonly path: PathEntry[],
  ) {
    super(message);
    this.name = "CircularDependencyError";
  }
}

export class AsyncFactoryError extends Error {
  constructor(
    message: string,
    public readonly token?: Token,
    public readonly key?: ServiceKey,
    public readonly path: PathEntry[] = [],
  ) {
    super(message);
    this.name = "AsyncFactoryError";
  }
}

export class ScopeResolutionError extends Error {
  constructor(
    message: string,
    public readonly token: Token,
    public readonly key?: ServiceKey,
    public readonly path: PathEntry[] = [],
  ) {
    super(message);
    this.name = "ScopeResolutionError";
  }
}
