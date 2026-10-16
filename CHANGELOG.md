# Changelog

## v0.1.0 — 2026-10-16

First release. Extracted from tripgency's `tools/secrets/` with history.

- Configuration moves to `secrets.config.mjs`: scopes with per-key notes, apps
  with scopes, dotenv/example/schema/destination, environments, pairs,
  exemptions, placeholder pattern, provider env-var names, contract roots.
- `loadConfig()` runs once in the bin; every command takes the frozen `ctx`.
- Destinations are providers (`vercel`, `railway` built in; inline or by path).
- Schema validation is optional: `schema-unchecked` when `tsx` or `schema` is
  absent; `runner: 'node'` for JS-only schemas.
- `list --json` rows carry `note`; the grid pane shows it.
- `declaresEncryptedKey(text, key)` exported for key-less CI gates.
- Vercel targets come from `providers.vercel.targets` (the
  `VERCEL_SYNC_TARGETS_*` environment override is gone).
- Command hints say `sops-env <cmd>`; messages name `secrets.config.mjs`.
- An unknown subcommand exits 2; a missing config exits 1.
- Coverage floors: lines 68 / functions 75 / branches 71 / statements 68
  (measured 74.58 / 81.51 / 76.91 / 74.15; the floors are unchanged).
