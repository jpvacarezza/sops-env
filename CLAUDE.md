# sops-env

SOPS + age secrets CLI, consumed as `github:jpvacarezza/sops-env#vX.Y.Z`.
Everything below is shared by `AGENTS.md` and `CLAUDE.md`; edit both.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test               # vitest run; `sops` must be on PATH (CI pins 3.11.0)
pnpm lint               # eslint .
pnpm format:check       # prettier --check . (covers Markdown); `pnpm format` writes
```

Node >= 24, pnpm 11. Try the CLI on the fixture project: `pnpm try` opens the grid,
`pnpm try list` (or any command and args) passes through to `bin/sops-env.mjs`.

## Architecture (`src/`)

- `cli.mjs`: dispatch; calls `loadConfig()` once, passes the frozen `ctx`.
- `config/`: `load` (find `secrets.config.mjs`), `resolve` (defaults, validation,
  deep-frozen `ctx`), `types.d.ts`.
- `store/`: `paths` (store, secrets and `.env` locations), `sops` decrypt, ciphertext
  inventory, dotenv writing, `project` (validate a document, project it per app).
- `model/`: pure planners and checks (matrix, invariants, sync and set plans,
  env contract, materialized-file findings).
- `providers/`: `vercel`, `railway`, the provider registry, `redact.mjs`.
- `schema/`: optional pass of `audit`: runs each app's validator command (any language, argv, no shell).
- `ui/`: the grid, split by layer: `shell-layout` (geometry), `shell-state` (pure
  reducer), `shell-render` (painting); `shell.mjs` only re-exports them. Plus
  `console` (the loop), prompts, clipboard.
- `commands/`: one file per CLI command, plus `args.mjs`.
- `index.mjs`: public API. Specs sit beside their modules (`*.spec.mjs`);
  `test/fixtures/project` is a consumer with real ciphertext.

## Rules

- **Zero runtime dependencies** (ADR-0001). `src/` imports only `node:` and
  relative modules; a spec pins it.
- **Values are never logged, printed or put on an argv** (ADR-0002). Output
  carries names or fingerprints; platform errors go through
  `src/providers/redact.mjs`. Details load with `.claude/rules/secrets-handling.md`.
- **Take `ctx` as the first argument; no module-level config** (ADR-0004).
- **Never use `--trust-lockfile`**, and install with `--frozen-lockfile`. The
  lockfile SHA is the pin consumers rely on (ADR-0003).
- No `prepare`, `postinstall` or `build` script in `package.json` (ADR-0003).
- **Behavior-changing PRs follow `docs/verification.md`**: capture on `main`,
  change, diff, and say in the PR which commands ran.
- Add a `CHANGELOG.md` entry under Unreleased for any user-visible change.

## Git

Git and GitHub text is English: commits, branches, PR titles and bodies. Use
Conventional Commits (`feat(set): ...`, `fix: ...`, `docs: ...`). Do not mirror
the chat language into a commit. Do not push or tag unless asked.

## Where things live

- `docs/adr/`: why (index in `docs/adr/README.md`). A lasting choice gets an ADR.
- `docs/superpowers/specs/` then `plans/`: design and plan before behavior work
  (flow in `docs/superpowers/README.md`).
- `docs/verification.md`: before/after practice for behavior changes.

## Context budget

Always-on instructions are paid on every turn. Do not grow this file with task
dumps; put task detail in an ADR, a spec, or a path-scoped rule under
`.claude/rules/`. `.ignore` hides generated files and executed plans from Grep
and Glob sweeps; name the path to reach them. Do not read
`src/ui/shell-render.mjs` (about 40 KB) or `shell-state.mjs` (about 18 KB) end to
end; jump to the function.
