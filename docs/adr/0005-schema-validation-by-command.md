# ADR-0005: Schema validation by external command, key names by JSON Schema

- Status: accepted
- Date: 2026-10-17

## Context

`audit` has to answer "would this projection fail at boot?". Until v0.2.2 it
did so by importing a JavaScript or TypeScript module the consumer named
(`schema: { file, exportName }`) in a child `tsx` process, and it read the
variable names and their presence (`required`, `default`, `optional`) out of the
same file with a regex that matched `KEY: z`.

That tied the tool to one language and one validation library. An app written
in Python, Go or Rust could not use the schema pass at all, and a Node app that
did not use Zod could not use the grid's presence markers. The regex was also
the kind of check that fails silently when the source is reshaped, which is why
it carried a "found no keys" guard.

## Decision

An app's `schema` has two independent, optional parts.

- **`command`** is an argv, run without a shell, with the app's projection in
  its environment plus `SOPS_ENVIRONMENT` and `NODE_ENV`. The exit status is the
  whole protocol: `0` valid, `78` (`EX_CONFIG`) could not run, anything else
  invalid. The runner never learns what language the command is written in.
- **`keys`** is a JSON Schema document, read with `JSON.parse` for `properties`,
  `required` and `default` only. It declares names and presence. It is never
  used to judge a value.

The tool does not validate values itself. The only authority on whether an
environment is valid is the app's own code, run as it runs at boot. A JSON
Schema validator in the tool would be a second copy of the contract, could not
express cross-variable or per-environment rules, and would need a dependency
(ADR-0001) or a hand-written subset to maintain.

What the command prints becomes the finding's message, so it passes through
`src/providers/redact.mjs` with every projected value first (ADR-0002). Some
validators quote the value they reject.

## Consequences

- Any language works. A consumer writes a thin wrapper that loads its own
  validator and maps the outcome to an exit status; the README has recipes.
- `tsx` and `zod` stop being peer dependencies, and the package no longer
  resolves anything from the consumer's `node_modules`.
- The keys file is a manifest that can drift from the app's code. The remedy is
  to generate it from the model in CI, not to make the tool smarter.
- A wrapper that crashes before it can classify its failure exits `1`, which
  reads as `invalid`. The `78` convention is how a wrapper says "this tool is
  broken, not the store"; it is documented, not enforced.
- Breaking for every consumer that configured `schema`, `schemaRunner` or
  `exemptions.unparsedBySchema` (renamed `undeclared`). The config loader names
  the replacement for each.
