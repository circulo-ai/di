import type { ServiceKey, Token } from "./types.js";

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

export class DisposedScopeError extends Error {
  constructor(
    message = "Cannot use a service scope after it has been disposed.",
  ) {
    super(message);
    this.name = "DisposedScopeError";
  }
}

export class DisposedProviderError extends Error {
  constructor(
    message = "Cannot use a service provider after it has been disposed.",
  ) {
    super(message);
    this.name = "DisposedProviderError";
  }
}
