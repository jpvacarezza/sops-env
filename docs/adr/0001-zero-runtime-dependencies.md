# ADR-0001: Zero runtime dependencies

- Status: accepted
- Date: 2026-10-16

## Context

sops-env handles decrypted secrets. Every package it depends on at runtime
runs with access to them, so the dependency graph is part of the trust
boundary. The tool was extracted from a repository whose dependency policy
(a publish-age floor on every new direct package) was written for exactly this
reason; a package that has no dependencies has nothing to gate.

## Decision

`package.json` declares `"dependencies": {}`. Runtime code imports only `node:`
builtins and relative modules. `sops`, `git` and a clipboard tool are external
programs on `PATH`, not packages. `tsx` and `zod` are optional peer
dependencies (`peerDependenciesMeta`), used only by the optional schema pass of
`audit`, and `tsx` is resolved from the consumer's root rather than this
package.

A test pins it: `src/commands/audit.spec.mjs` ("the package reaches only node
builtins") fails when a file under `src/` imports something that is neither
relative nor `node:`.

## Consequences

- The interactive grid, argument parsing, dotenv writing and the provider HTTP
  calls (`fetch`) are first-party code. That costs lines and is accepted.
- Adding a dependency is a decision to reverse this ADR, not a routine change.
  Dev-only tooling (vitest, eslint, prettier) is unaffected.
- A consumer installs a tarball unpack with no transitive graph to audit.

**Amended 2026-10-17.** `tsx` and `zod` are no longer optional peer dependencies.
ADR-0005 replaced the schema pass of `audit` with an external command the
consumer names, so the package declares no peer dependencies and resolves
nothing from the consumer's `node_modules`.
