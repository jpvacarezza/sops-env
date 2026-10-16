# ADR-0004: An explicit, frozen `ctx` and no singleton

- Status: accepted
- Date: 2026-10-16

## Context

The tool came from code that read a hardcoded registry, hardcoded paths and a
hardcoded rule for which app goes to which platform. Generalizing it needs a
configuration, and the question is how modules reach it.

## Decision

`loadConfig()` runs once, in `src/cli.mjs`, finds `secrets.config.mjs` by
walking up from the cwd (or `--config` / `$SOPS_ENV_CONFIG`), and
`resolveConfig()` returns a deep-frozen `ctx` (`deepFreeze` in
`src/config/resolve.mjs`). Every function that needs configuration takes `ctx`
as its first argument. There is no module-level config and no init call.

## Consequences

- Pure modules (`buildMatrix`, the grid reducer in `src/ui/shell.mjs`, the
  planners in `src/model/`) do not depend on a hidden setup step, and specs
  build a `ctx` directly instead of resetting modules.
- Threading `ctx` through every signature is verbose; that is the price.
- The `ctx` is frozen, so a command cannot leak state into another by
  mutating it.
- The public API (`src/index.mjs`) keeps the same shape: functions that read
  config take `ctx` from `loadConfig()` or `resolveConfig()`.
