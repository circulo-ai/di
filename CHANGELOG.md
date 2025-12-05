# Changelog

## 2.0.0

### Major Changes

- Added async factories with resolveAsync/tryResolveAsync, in-flight dedupe, and circular/missing/async scope errors carrying token/path for better diagnostics.

- Introduced lifetimes/features: GlobalSingleton (hot-reload safe), disposal priorities with onDispose hooks, withScope, and lifetime-aware Hono bindings (bindToHono, strict/cache proxy, decorateContext).

- Enhanced registration helpers: createToken/optional, useExisting/useClass, factory/lazy, keyed multi-resolution via resolveMap, collection defaults (allowOverwrite/defaultMultiple/trace/captureStack), env helpers (ifProd/ifDev/ifTruthy), and global disposers for value providers.

- Diagnostics \& tracing: graph validation warns/errors on mixed keyed/unkeyed, unused tokens, duplicate keys; tracing hook logs resolution path/lifetime.

- Hono sugar: typed context binding with DI proxy, strict missing-token errors, per-request memoization.

- Disposal semantics: priority-aware reverse order for scoped/singletons, support for dispose/close/destroy plus Symbol.dispose/Symbol.asyncDispose.

- Added metadata on descriptors (registeredAt/source) and guards for scoped resolution from root, async factory misuse, and circular dependency detection with breadcrumbs.

- Tests consolidated into packages/di/test/di.test.ts; coverage at 100% with Vitest config excluding examples/tests from coverage totals; new cases cover disposal priorities, tracing, proxies, env defaults, async paths, and global cache.

- Docs/README updated to reflect new lifetimes, helpers, Hono binding, tracing, disposal guidance, and recipes (global pools, per-request scopes, background jobs).

## 1.2.1

### Patch Changes

- Added a hono example for @circulo-ai/di package

## 1.2.0

### Minor Changes

- 37b9b8f: code reformat
- 69ee9ea: Added keywords to package.json
- 63d07d6: Enhanced package.json

## 1.1.0

- Added multi-registration and keyed services: register multiple implementations per token with optional `key`, resolve by key or via `resolveAll`.
- Added `tryResolve`, `resolveAll`, and descriptor helpers; Hono helper gained `tryResolveFromContext` and supports custom variable names.
- Improved scoped caching and singleton disposal tracking; disposes singletons deterministically.
- Build now excludes tests (`tsconfig.build.json`), while type checks still cover tests.
- Tests expanded (38→38 TS/JS variants) covering lifetimes, disposal paths, keyed/multi resolves, and Hono middleware; coverage ~96–100%.
- Package metadata hardened for publishing: files whitelist, `publishConfig`, `prepack`, `release` script.
