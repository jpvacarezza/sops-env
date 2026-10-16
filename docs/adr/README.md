# Architectural Decision Records

Why sops-env is built the way it is. Behavior and usage live in the
[README](../../README.md); this directory holds the decisions a future editor
would otherwise reverse by accident.

## When to write one

A lasting choice that is costly to undo or that a reasonable contributor would
second-guess: a property the package promises, a dependency policy, a seam
between modules. Not for bug fixes or features that follow an existing ADR.

## Format

File name `NNNN-short-kebab-title.md`, numbered in order of writing.

```markdown
# ADR-NNNN: Short title

- Status: proposed | accepted | superseded by ADR-NNNN
- Date: YYYY-MM-DD

## Context

## Decision

## Consequences
```

An accepted ADR is not rewritten. A change of course is a dated paragraph at
the end, `**Amended YYYY-MM-DD.** ...`, or a new ADR that supersedes it.

## Index

- [0001 — Zero runtime dependencies](./0001-zero-runtime-dependencies.md)
- [0002 — Values never leave a process except as fingerprints or behind a closure](./0002-values-never-leave-the-process.md)
- [0003 — Distribution by first-party git tag, not npm](./0003-distribution-by-git-tag.md)
- [0004 — An explicit, frozen `ctx` and no singleton](./0004-explicit-frozen-ctx.md)

Design specs live in [../superpowers/](../superpowers/README.md).
