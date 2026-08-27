# Changelog

## 3.4.0

### Minor Changes

- 05a2f9d: Harden provider and scope lifecycle management, add explicit disposal ownership and global cleanup, support async multi-resolution, add safer missing-only resolution helpers and startup dependency validation, expose Hono and Next adapter entrypoints, improve production documentation and framework error handling, and provide a complete README reference with copy-paste examples, outputs, lifecycle guidance, adapters, testing, and release workflows.

## 3.3.0

### Minor Changes

- Release the accumulated public-package improvements, including the upload
  provider adapters, FTP/FTPS support, typed file routers, React upload helpers,
  and the associated runtime and developer-experience updates.

## 3.2.1

### Patch Changes

- 8bbbe7e: Ship the production-ready workflow, dependency-injection, file-parsing, and upload runtime improvements together with their validated build and test tooling.

## 3.2.0 - 2026-08-09

### Minor Changes

- Added reflection-free constructor annotations through `injectable()` and `annotate()`. Annotated classes work with `bind(...).toClass(...)` and `useClass()` without adding `reflect-metadata`.
- Added a .NET-inspired developer experience: annotated class self-registration, `buildServiceProvider()`, `getRequiredService()`, `getService()`, `getServices()`, scoped `serviceProvider`, and `disposeAsync()` aliases.
- Added `resolveMap()` to scoped and factory resolvers, so keyed scoped services retain the active scope.

### Reliability and Security

- Fixed scoped circular dependencies bypassing cycle detection and fixed `resolveAll()` losing scope context inside factories.
- Failed async singleton, global-singleton, and scoped factories no longer poison in-flight caches; later resolutions can retry safely.
- Disposing a scope now waits for in-flight scoped creation, attempts all cleanup operations even if one fails, and prevents use-after-dispose with `DisposedScopeError`.
- Singleton and scoped factories that return `undefined` are now cached correctly.
- Global-singleton cache keys now preserve token identity, preventing collisions between distinct symbols or classes with identical labels. Use an explicit `globalKey` for stable reuse when hot reload recreates a token.
- `resolveMap()` safely handles prototype-like keys such as `__proto__` without mutating the result object's prototype.
- Function-valued services are no longer invoked as implicit disposal callbacks. Explicit value-provider disposers continue to be supported.

### Packaging and Developer Experience

- Cleaned stale build output before verification and packaging, preventing compiled tests and duplicate `dist/src` trees from entering npm tarballs.
- Added native Node.js ESM package smoke testing and `.js` import specifiers so the published output works without bundler-specific resolution.
- Added a complete Apache-2.0 license file, ESM import metadata, a Node.js engine declaration, and `sideEffects: false` for bundlers.
- Upgraded Hono development types and Vitest tooling, restricted test discovery to source tests, and made `prepack` run the complete clean/typecheck/test/build gate.
- Corrected non-working README examples, documented annotation usage and disposed-scope behavior, and restored missing historical changelog entries.
- Added executable annotation, modular application, background worker, Next.js-style, and annotated Hono examples; the prepack gate now type-checks them and runs the annotation example against the built package.

## 3.1.0 - 2025-12-22

### Minor Changes

- Added `createServiceLocator` with strict and memoized modes, nested token-tree typing, own-property guards, optional tokens, and collision-safe property caching.
- Reused the locator in the Hono integration. `bindToHono` now defaults to `cache: false` to preserve transient semantics.

## 3.0.1 - 2025-12-21

### Patch Changes

- Updated the README.

## 3.0.0 - 2025-12-21

### Major Changes

- Added the fluent binding DSL and reusable service modules.

## 2.1.1 - 2025-12-10

### Patch Changes

- Updated workspace and package-manager integration.

## 2.1.0

### Minor Changes

- 2b6380b: Minor updates

## 2.0.1

### Patch Changes

- 563b44b: Updated docs.md

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
