---
alwaysApply: false
paths: src/store/**,src/providers/**,test/fixtures/**
---

# Secrets handling

Rationale: `docs/adr/0002-values-never-leave-the-process.md`.

- **Never print, log, throw or interpolate a decrypted value.** Not in an error
  message, a debug line, a spec's failure text or a snapshot. Names and
  fingerprints only.
- **A value is never an argv to a child process.** It goes on stdin (see how
  `set` calls `sops set --value-stdin`).
- **Platform error bodies pass through `src/providers/redact.mjs`** with every
  value being synced, before they are printed or thrown. A new provider does the
  same.
- **The fixture age key `test/fixtures/age-key.txt` is the only committed key.**
  It decrypts fixture placeholders and protects nothing. Do not add another key,
  a real value, or a decrypted copy under `test/fixtures/`; the `.gitignore`
  excludes decrypted working copies on purpose, do not loosen it.
- **Fixture ciphertext is not reformatted.** Prettier skips
  `test/fixtures/project/secrets/*.enc.yaml`; editing it by hand breaks the MAC.
  Regenerate it with `sops` and the fixture key.
- **The config holds names only.** Do not add a code path that accepts a value
  in `secrets.config.mjs`.
