/**
 * Reads what a ciphertext file declares, without decrypting it.
 *
 * SOPS encrypts values and leaves mapping keys in plaintext, so presence — which
 * variable exists under which scope, in which environment — is answerable with
 * no age key at all. `trust-proxy-ciphertext.spec.mjs` already relies on this to
 * gate `TRUST_PROXY` in CI, where no key exists; this generalises the same trick
 * from one key to the whole document.
 *
 * A line scanner rather than a YAML parser, deliberately. The shape is fixed and
 * narrow — column-0 scope keys, one level of indented `KEY: ENC[…]`, then a
 * `sops:` trailer — and a YAML dependency would cost a new direct package under
 * ADR-0017's 3-day publish floor and `no-downgrade` trust policy, permanently,
 * to parse three files whose shape SOPS itself controls.
 */
import { readFileSync } from 'node:fs';

import { SCOPES } from '../scopes.mjs';

/** A column-0 mapping key: `api:`, `sops:`, `shared: {}`. */
const TOP_LEVEL = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
/** An indented entry. The name class excludes `-`, so `- recipient:` never matches. */
const ENTRY = /^[ \t]+([A-Z][A-Z0-9_]*):[ \t]*(.*)$/;

/**
 * `{ scope: { keys: { KEY: { line, encrypted } } } }` for one document's text.
 *
 * Refuses a flow mapping (`api: {A: "b"}`) instead of reporting the scope empty.
 * Reporting it empty is the one failure that matters here: every caller would
 * then believe the scope has no variables and offer to *add* keys that already
 * exist, which is how you overwrite a value you meant to leave alone.
 */
export function parseInventory(
  text,
  { scopes = SCOPES, file = '<text>' } = {},
) {
  const inventory = {};
  let scope = null;

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    // `#ENC[…,type:comment]` — staging and production each open with two of
    // these. Encrypted or not, a comment declares no variable.
    if (line.trimStart().startsWith('#')) return;

    const top = TOP_LEVEL.exec(line);
    if (top) {
      const [, name, rest] = top;
      // Any column-0 key that is not a scope ends the scope region. `sops:`
      // above all: its `age:` list and `mac:`/`version:` lines are indented and
      // would otherwise read as variables of whichever scope came last.
      scope = scopes.includes(name) ? name : null;
      if (!scope) return;

      // A trailing comment is legal and carries nothing. Anything else after
      // the scope name — a flow mapping, a scalar, an anchor — is content this
      // reader cannot see into, and the failure would be a scope reported empty.
      const inline = rest.replace(/(^|\s)#.*$/, '').trim();
      if (inline !== '' && inline !== '{}') {
        throw new Error(
          `${file}:${index + 1}: scope "${name}" is followed by ${JSON.stringify(inline)}. ` +
            'This reader scans lines and cannot see inside a flow mapping or a ' +
            'scalar, so it would report the scope as empty and every caller ' +
            'would then treat existing variables as missing — and offer to add ' +
            'keys that already hold a value. Rewrite it as a block mapping, one ' +
            '`KEY: "value"` per indented line.',
        );
      }

      if (inventory[scope]) {
        throw new Error(
          `${file}:${index + 1}: scope "${name}" appears twice. Merging is not ` +
            'this reader’s to guess at, and overwriting would hide every ' +
            'key of the first block.',
        );
      }

      inventory[scope] = { keys: {} };
      return;
    }

    if (scope === null) return;

    const entry = ENTRY.exec(line);
    if (!entry) {
      // An indented line inside a scope is a variable or it is nothing this
      // reader understands. Skipping it silently is the one outcome that must
      // not happen: a quoted key (`"DATABASE_URL": ENC[…]`) is legal YAML, and
      // dropping it shows the variable as unset while it holds a live value.
      throw new Error(
        `${file}:${index + 1}: cannot read ${JSON.stringify(line.trim().slice(0, 60))} ` +
          `as a variable of scope "${scope}". Names here are unquoted ` +
          'UPPER_SNAKE_CASE. Silently skipping it would show a variable as ' +
          'unset while it holds a value, which is how one gets overwritten.',
      );
    }

    const [, key, value] = entry;
    inventory[scope].keys[key] = {
      line: index + 1,
      encrypted: value.startsWith('ENC['),
    };
  });

  return inventory;
}

/** Recipients the document itself carries. Public keys, safe to print. */
export function readRecipients(text) {
  return [...text.matchAll(/^\s*-\s*recipient:\s*(age1[0-9a-z]+)/gm)].map(
    (match) => match[1],
  );
}

/** The `lastmodified` stamp SOPS rewrites on every write. */
export function readLastModified(text) {
  return /^\s*lastmodified:\s*"?([^"\n]+)"?/m.exec(text)?.[1] ?? null;
}

/** Everything readable from one environment's file without a key. */
export function readEnvironment(file, { readFile = readFileSync } = {}) {
  const text = readFile(file, 'utf8');

  return {
    inventory: parseInventory(text, { file }),
    recipients: readRecipients(text),
    lastModified: readLastModified(text),
  };
}
