# ADR-0002: Values never leave a process except as fingerprints or behind a closure

- Status: accepted
- Date: 2026-10-16

## Context

The tool decrypts every environment so it can project, compare and sync them.
The failure to design against is a value reaching a log, terminal scrollback,
a process listing, a CI artifact or a committed file.

## Decision

- **Output carries names, never values.** `list`, `check`, `audit` and
  `sync --dry-run` print variable and destination names. Where a comparison
  needs a value's identity, they print a fingerprint: an HMAC with a per-run
  random salt, eight hex characters, so it cannot be matched across runs.
- **A value is never an argument to `sops-env`.** `set` reads stdin or a masked
  prompt and hands the value to `sops set --value-stdin` on the child's stdin,
  so it is on no argv (this is why `sops` >= 3.11.0 is required).
- **Plaintext lives behind a closure.** Decrypted data is consumed by the
  function that needs it (`run`, `materialize`, `sync`) and is not returned to
  callers that print.
- **Platform errors are redacted.** `src/providers/redact.mjs` replaces every
  synced value of four or more characters, raw and JSON-escaped, with
  `<redacted>`, longest first, and caps the text at 500 characters.
- **The config file holds names only.** The loader rejects a key note that
  starts with `age1`, `AGE-SECRET-KEY-` or `ENC[`, or contains `=`; the same
  guard covers provider name fields, pair `name`/`why` and exemption reasons,
  and a rejected string is never echoed.
- **Materialized files are guarded.** `materialize` writes mode 0600 and
  refuses a target git does not ignore.

## Consequences

- Debugging by printing a value is not available; use fingerprints, or
  `SOPS_ENV_DEBUG=1` (a stack, not data).
- Values shorter than four characters are not redacted from platform errors:
  replacing `1` or `true` would hide nothing and shred the message.
- Every new command or provider is reviewed against this list. The
  path-scoped rule `.claude/rules/secrets-handling.md` restates it for agents.
