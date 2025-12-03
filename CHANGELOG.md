# Changelog

## 1.1.0

- Added multi-registration and keyed services: register multiple implementations per token with optional `key`, resolve by key or via `resolveAll`.
- Added `tryResolve`, `resolveAll`, and descriptor helpers; Hono helper gained `tryResolveFromContext` and supports custom variable names.
- Improved scoped caching and singleton disposal tracking; disposes singletons deterministically.
- Build now excludes tests (`tsconfig.build.json`), while type checks still cover tests.
- Tests expanded (38→38 TS/JS variants) covering lifetimes, disposal paths, keyed/multi resolves, and Hono middleware; coverage ~96–100%.
- Package metadata hardened for publishing: files whitelist, `publishConfig`, `prepack`, `release` script.
