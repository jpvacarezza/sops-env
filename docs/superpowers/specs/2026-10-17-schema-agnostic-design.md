# Language-agnostic schema pass

Date: 2026-10-17. Decision record: [ADR-0005](../../adr/0005-schema-validation-by-command.md).

## Problem

`apps.<app>.schema = { file, exportName }` only works for a JavaScript or
TypeScript module, and the variable names and presence markers are read from it
with a regex that matches Zod's `KEY: z` shape. An app in any other language, or
a Node app on another validation library, gets no schema pass and no `req`/`opt`
markers in the grid. The audit child's output also reached the report without
redaction (ADR-0002).

## Decisions

1. **Validation is the app's own command.** `schema.command` is an argv, run
   without a shell, with the projection, `SOPS_ENVIRONMENT` and `NODE_ENV` in its
   environment. Exit `0` valid, `78` could not run, anything else invalid.
   Reason: only the app's code knows what valid means at boot, and an exit
   status is the one interface every language has.
2. **Names come from a JSON Schema file.** `schema.keys` is read with
   `JSON.parse` for `properties`, `required` and `default`. It never judges a
   value. Reason: a data format needs no regex and no source scan, and Zod 4 and
   pydantic can both generate it.
3. **No value validation in the tool.** A JSON Schema validator would be a second
   copy of the contract, could not express cross-variable rules, and needs a
   dependency (ADR-0001).
4. **Output is redacted.** The command's stderr (else stdout) goes through
   `redact()` with every projected value and is capped at 500 characters.
5. **Failure classes.** Command not found is `schema-missing` (error), so a typo
   cannot disable the gate. Status `78`, a spawn failure, a timeout or a signal is
   `schema-unchecked` (warn). Otherwise `schema-invalid` (error).
6. **Breaking, no compatibility layer.** `schema.file`, `schema.exportName`,
   `schemaRunner` and the child scripts are removed; `exemptions.unparsedBySchema`
   becomes `undeclared`. The loader names the replacement for each old key.
   `tsx` and `zod` leave the peer and dev dependencies.

## Config

```js
schema: {
  keys: 'apps/api/env.schema.json', // optional
  command: ['python', '-m', 'api.config'], // optional
  cwd: 'tmp', // optional, default
}
```

At least one of `keys` and `command`. `cwd` is `'tmp'` or a path relative to the
config; it defaults to the OS temp directory so a loader that reads dotenv from
the working directory finds nothing.

## Verification

Per `docs/verification.md`: capture `list --json`, `audit --no-schema`,
`audit` (with schema), `check --decrypt`, `sync staging --dry-run` and the
materialized hashes on `main`, then on the branch, and diff. Expected deltas:
the `audit` note about the schema pass, and `defaultLiteral` in `list --json`,
which is now the default's value (`info`) and no longer its source text
(`'info'`). Everything else is byte-identical.

Unit coverage: `runner.spec.mjs` (status mapping, redaction, no shell, real
spawns), `env-contract.spec.mjs` (JSON Schema reader), `resolve.spec.mjs`
(config shape and migration errors).
