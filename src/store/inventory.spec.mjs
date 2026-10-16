import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  declaresEncryptedKey,
  parseInventory,
  readEnvironment,
  readLastModified,
  readRecipients,
} from './inventory.mjs';
import { secretsFilePath } from './paths.mjs';
import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';

const ctx = registryCtx({ shared: [], api: [], web: [], admin: [] });

const enc = (tag) =>
  `ENC[AES256_GCM,data:${tag},iv:iv${tag}=,tag:tag${tag}==,type:str]`;

const body = (indent) =>
  [
    'shared: {}',
    'api:',
    `${indent}DATABASE_URL: ${enc('aaa')}`,
    `${indent}LOG_LEVEL: ${enc('bbb')}`,
    'web:',
    `${indent}API_URL: ${enc('ccc')}`,
    'sops:',
    `${indent}kms: []`,
    `${indent}age:`,
    `${indent}${indent}- recipient: age19pu4qdgn4eu88pkf3vuvpc6r8gjhyyuxcxsnh9kyn3nrsvrfqatq6gek4m`,
    `${indent}${indent}  enc: |`,
    `${indent}${indent}    -----BEGIN AGE ENCRYPTED FILE-----`,
    `${indent}${indent}    YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0rIFgyNTUxOSBGdUVP`,
    `${indent}${indent}    -----END AGE ENCRYPTED FILE-----`,
    `${indent}lastmodified: "2026-08-13T05:07:21Z"`,
    `${indent}mac: ${enc('mmm')}`,
    `${indent}version: 3.9.4`,
    '',
  ].join('\n');

const FOUR_SPACE = body('    ');
const TWO_SPACE = body('  ');

/** What staging and production actually open with. */
const WITH_ENCRYPTED_COMMENTS = `#ENC[AES256_GCM,data:zzz,iv:i=,tag:t==,type:comment]
#ENC[AES256_GCM,data:yyy,iv:i=,tag:t==,type:comment]
${FOUR_SPACE}`;

describe('parseInventory', () => {
  it('reads scopes and their keys', () => {
    expect(Object.keys(parseInventory(ctx, FOUR_SPACE))).toEqual([
      'shared',
      'api',
      'web',
    ]);
    expect(Object.keys(parseInventory(ctx, FOUR_SPACE).api.keys)).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
    ]);
  });

  // Every file is 4-space today because that is what sops writes, but the
  // reader must not encode that: a `sops` upgrade is allowed to reindent.
  it('does not care whether the file is 2-space or 4-space', () => {
    expect(parseInventory(ctx, TWO_SPACE)).toEqual(
      parseInventory(ctx, FOUR_SPACE),
    );
  });

  it('records `shared: {}` as present and empty, not as missing', () => {
    expect(parseInventory(ctx, FOUR_SPACE).shared).toEqual({ keys: {} });
  });

  it('marks an ENC[ value as encrypted', () => {
    expect(
      parseInventory(ctx, FOUR_SPACE).api.keys.DATABASE_URL.encrypted,
    ).toBe(true);
  });

  it('marks a plaintext value as not encrypted', () => {
    const leaked = ['api:', '    DATABASE_URL: postgresql://host/db', ''].join(
      '\n',
    );

    expect(parseInventory(ctx, leaked).api.keys.DATABASE_URL.encrypted).toBe(
      false,
    );
  });

  it('reports the line each key sits on', () => {
    expect(parseInventory(ctx, FOUR_SPACE).api.keys.DATABASE_URL.line).toBe(3);
  });

  // The `sops:` trailer is the trap: its `mac:` and `version:` lines are
  // indented exactly like a variable, so a reader that does not end the scope
  // region at a non-scope top-level key files them under `web`.
  it('takes nothing from the sops trailer', () => {
    const inventory = parseInventory(ctx, FOUR_SPACE);

    expect(Object.keys(inventory.web.keys)).toEqual(['API_URL']);
    expect(inventory.sops).toBeUndefined();

    const everyKey = Object.values(inventory).flatMap((scope) =>
      Object.keys(scope.keys),
    );
    expect(everyKey).toEqual(['DATABASE_URL', 'LOG_LEVEL', 'API_URL']);
  });

  it('takes nothing from the encrypted comment preamble', () => {
    const shape = (inventory) =>
      Object.fromEntries(
        Object.entries(inventory).map(([scope, entries]) => [
          scope,
          Object.keys(entries.keys),
        ]),
      );
    const withComments = parseInventory(ctx, WITH_ENCRYPTED_COMMENTS);
    const without = parseInventory(ctx, FOUR_SPACE);

    expect(shape(withComments)).toEqual(shape(without));
    // And the reported lines shift by exactly those two comment lines, which is
    // the other half of the contract: a line number has to be the real one, so
    // it can be followed into the file.
    expect(withComments.api.keys.DATABASE_URL.line).toBe(
      without.api.keys.DATABASE_URL.line + 2,
    );
  });

  // Reporting the scope empty is the failure that matters: a caller would then
  // offer to add keys that already exist, and adding is overwriting.
  it('refuses a flow mapping instead of reporting the scope empty', () => {
    expect(() =>
      parseInventory(ctx, 'api: { DATABASE_URL: "x" }', {
        file: 'secrets/local.enc.yaml',
      }),
    ).toThrow(/secrets\/local\.enc\.yaml:1: scope "api" is followed by/);
  });

  it('still accepts the empty flow mapping, which is how `shared` is written', () => {
    expect(() => parseInventory(ctx, 'shared: {}')).not.toThrow();
  });

  it('accepts a trailing comment on the scope line, which carries nothing', () => {
    const commented = ['api: # the api scope', '    A: ENC[a]', ''].join('\n');

    expect(Object.keys(parseInventory(ctx, commented).api.keys)).toEqual(['A']);
  });

  // A quoted key is legal YAML, and skipping it shows a variable as unset while
  // it holds a live value — which is how the grid comes to offer to "add" a key
  // and overwrites it.
  it('refuses a quoted key rather than dropping it', () => {
    const quoted = ['api:', '    "DATABASE_URL": ENC[a]', ''].join('\n');

    expect(() => parseInventory(ctx, quoted)).toThrow(/cannot read/);
  });

  it('refuses an indented line it cannot read as a variable', () => {
    const odd = ['api:', '    database_url: ENC[a]', ''].join('\n');

    expect(() => parseInventory(ctx, odd)).toThrow(/UPPER_SNAKE_CASE/);
  });

  // Overwriting the first block would hide every key in it.
  it('refuses a repeated scope rather than keeping only the last block', () => {
    const twice = ['api:', '    A: ENC[a]', 'api:', '    B: ENC[b]', ''].join(
      '\n',
    );

    expect(() => parseInventory(ctx, twice)).toThrow(/appears twice/);
  });

  it('refuses a scalar after the scope name', () => {
    expect(() => parseInventory(ctx, 'api: oops')).toThrow(/is followed by/);
  });

  it('ignores a top-level key that is not a scope', () => {
    const extra = ['metadata:', '    NOT_A_VARIABLE: ENC[x]', ''].join('\n');

    expect(parseInventory(ctx, extra)).toEqual({});
  });
});

describe('readRecipients', () => {
  it('reads the age recipients the document carries', () => {
    expect(readRecipients(FOUR_SPACE)).toEqual([
      'age19pu4qdgn4eu88pkf3vuvpc6r8gjhyyuxcxsnh9kyn3nrsvrfqatq6gek4m',
    ]);
  });

  it('returns nothing when there is no sops block', () => {
    expect(readRecipients('api:')).toEqual([]);
  });
});

describe('readLastModified', () => {
  it('reads the stamp', () => {
    expect(readLastModified(FOUR_SPACE)).toBe('2026-08-13T05:07:21Z');
  });

  it('returns null when there is none', () => {
    expect(readLastModified('api: {}')).toBeNull();
  });
});

// Against the real files, the way trust-proxy-ciphertext.spec.mjs does: a line
// scanner that only ever ran against its own fixture is a fixture test.
describe('the reader still matches the real ciphertext', () => {
  const real = fixtureCtx();
  for (const environment of real.environments) {
    describe(environment, () => {
      const file = secretsFilePath(real, environment);
      const text = readFileSync(file, 'utf8');
      const { inventory, recipients, lastModified } = readEnvironment(
        real,
        file,
      );

      it('finds only real scopes', () => {
        for (const scope of Object.keys(inventory)) {
          expect(real.scopes).toContain(scope);
        }
      });

      it('finds api.DATABASE_URL, encrypted', () => {
        expect(inventory.api?.keys?.DATABASE_URL).toMatchObject({
          encrypted: true,
        });
      });

      it('finds every value encrypted', () => {
        const plaintext = Object.entries(inventory).flatMap(
          ([scope, entries]) =>
            Object.entries(entries.keys)
              .filter(([, entry]) => !entry.encrypted)
              .map(([key]) => `${scope}.${key}`),
        );

        expect(plaintext).toEqual([]);
      });

      // Every ENC[ blob is either a variable, the document `mac`, or an
      // encrypted header comment — staging and production carry two of those
      // each. Anything left unaccounted for is a variable the reader skipped.
      it('accounts for every ENC[ blob in the file', () => {
        const found = Object.values(inventory).reduce(
          (total, entries) => total + Object.keys(entries.keys).length,
          0,
        );
        const blobs = text.split('ENC[').length - 1;
        const comments = (text.match(/^#ENC/gm) ?? []).length;

        expect(found).toBe(blobs - 1 - comments);
      });

      it('carries at least one recipient and a stamp', () => {
        expect(recipients.length).toBeGreaterThan(0);
        expect(lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    });
  }
});

describe('declaresEncryptedKey', () => {
  const text = readFileSync(secretsFilePath(fixtureCtx(), 'staging'), 'utf8');

  it('finds a key whose value is ciphertext, without decrypting', () => {
    expect(declaresEncryptedKey(text, 'DATABASE_URL')).toBe(true);
  });

  it('does not find a key that is absent', () => {
    expect(declaresEncryptedKey(text, 'NOPE')).toBe(false);
  });

  it('does not match a plaintext value', () => {
    expect(declaresEncryptedKey('api:\n    A: plain\n', 'A')).toBe(false);
  });
});
