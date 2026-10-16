# Specs and plans

Work that changes behavior or structure goes through two committed documents
before code.

1. **Spec**: `specs/YYYY-MM-DD-<topic>-design.md`. The problem, the decisions
   with their reasons, the verification. Specs stay searchable; a decision that
   must outlive the work belongs here or in an [ADR](../adr/README.md).
2. **Plan**: `plans/YYYY-MM-DD-<topic>.md`. The spec turned into tasks, each
   under a `### Task N: <title>` heading so one task can be read alone. Split a
   plan that passes about 12 tasks into one plan per shippable PR.

Both are committed, in English, with the date the document was started. A plan
whose PR has merged is executed: leave it in place and hide it from sweeps by
adding it to `docs/superpowers/.ignore`.

Local agent scratch notes live in `.superpowers/`, which is gitignored and
outside Prettier; nothing there is a source of truth.

The design this package implements was written before the package existed
(`docs/superpowers/specs/2026-10-15-sops-env-package-design.md`). Its Decisions
are summarized by the ADRs here.
