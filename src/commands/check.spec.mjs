import { describe, expect, it } from 'vitest';
import {
  assertCiphertext,
  looksEncrypted,
  strayEntries,
  sweepStrayPlaintext,
} from './check.mjs';
import { fixtureCtx } from '../../test/helpers/ctx.mjs';

const CTX = fixtureCtx();

const ENCRYPTED = `shared:
    SERVICE_KEY: ENC[AES256_GCM,data:abc==,iv:def=,tag:ghi==,type:str]
sops:
    age:
        - recipient: age1qqqq
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
    version: 3.9.4
`;

const PLAINTEXT = `shared:
    SERVICE_KEY: dev-internal-api-key-change-me
`;

/** The directory as a clean checkout has it. */
const CLEAN = [
  ...CTX.environments.map((environment) => `${environment}.enc.yaml`),
  ...CTX.store.tracked,
];

describe('looksEncrypted', () => {
  it('accepts a SOPS document', () => {
    expect(looksEncrypted(ENCRYPTED)).toBe(true);
  });

  it('rejects plaintext YAML that happens to be in the right place', () => {
    expect(looksEncrypted(PLAINTEXT)).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(looksEncrypted('')).toBe(false);
  });

  it('rejects a file with sops metadata but unencrypted values', () => {
    const partial = `${PLAINTEXT}sops:\n    version: 3.9.4\n`;

    expect(looksEncrypted(partial)).toBe(false);
  });
});

describe('assertCiphertext', () => {
  it('says nothing for an encrypted file', () => {
    expect(() =>
      assertCiphertext(ENCRYPTED, 'secrets/local.enc.yaml'),
    ).not.toThrow();
  });

  it('names the file and tells you not to commit it when it is plaintext', () => {
    expect(() => assertCiphertext(PLAINTEXT, 'secrets/local.enc.yaml')).toThrow(
      /secrets\/local\.enc\.yaml/,
    );
  });
});

describe('strayEntries', () => {
  it('finds nothing in a clean checkout', () => {
    expect(strayEntries(CTX, CLEAN)).toEqual([]);
  });

  // One case per sidecar spelling a SOPS editor integration is known to use.
  // The `.decrypted~` one is not hypothetical: it is what re-included plaintext
  // through the `!/secrets/*.enc.yaml` negation.
  it.each([
    '.decrypted~local.enc.yaml',
    '.decrypted~production.enc.yaml',
    'local.tmp.yaml',
    'local.enc.tmp.yaml',
    'local.plain.yaml',
    'local.enc.yaml.sops-backup.1',
    'staging.enc.yaml.bak',
  ])('treats %s as a stray', (sidecar) => {
    expect(strayEntries(CTX, [...CLEAN, sidecar])).toEqual([sidecar]);
  });

  it('returns strays sorted, so the message is stable', () => {
    expect(strayEntries(CTX, [...CLEAN, 'b.yaml', 'a.yaml'])).toEqual([
      'a.yaml',
      'b.yaml',
    ]);
  });

  it('counts a ciphertext file for an unknown environment as a stray', () => {
    expect(strayEntries(CTX, [...CLEAN, 'preview.enc.yaml'])).toEqual([
      'preview.enc.yaml',
    ]);
  });
});

describe('sweepStrayPlaintext', () => {
  const ignoresEverything = () => true;
  const ignoresNothing = () => false;
  const cannotTell = () => null;

  it('passes a clean directory', () => {
    expect(
      sweepStrayPlaintext(CTX, { entries: CLEAN, isIgnored: ignoresNothing }),
    ).toEqual({ committable: [], ignored: [] });
  });

  it('throws when a decrypted sidecar is committable, and names it', () => {
    expect(() =>
      sweepStrayPlaintext(CTX, {
        entries: [...CLEAN, '.decrypted~production.enc.yaml'],
        isIgnored: ignoresNothing,
      }),
    ).toThrow(/\.decrypted~production\.enc\.yaml/);
  });

  it('points at the negation, because a pattern above it does nothing', () => {
    expect(() =>
      sweepStrayPlaintext(CTX, {
        entries: [...CLEAN, '.decrypted~local.enc.yaml'],
        isIgnored: ignoresNothing,
      }),
    ).toThrow(/!\/secrets\/\*\.enc\.yaml/);
  });

  it('reports an ignored working copy without failing', () => {
    expect(
      sweepStrayPlaintext(CTX, {
        entries: [...CLEAN, 'local.plain.yaml'],
        isIgnored: ignoresEverything,
      }),
    ).toEqual({ committable: [], ignored: ['local.plain.yaml'] });
  });

  // Fail closed. A control that exists to prove nothing is exposed cannot treat
  // "git did not answer" as "git said no".
  it('treats a stray git cannot classify as committable', () => {
    expect(() =>
      sweepStrayPlaintext(CTX, {
        entries: [...CLEAN, 'local.plain.yaml'],
        isIgnored: cannotTell,
      }),
    ).toThrow(/local\.plain\.yaml/);
  });

  it('names only the committable stray, not the ignored one', () => {
    const sweep = () =>
      sweepStrayPlaintext(CTX, {
        entries: [...CLEAN, 'ignored.yaml', 'exposed.yaml'],
        isIgnored: (entry) => entry === 'ignored.yaml',
      });

    expect(sweep).toThrow(/exposed\.yaml/);
    // The separation is the point: a working copy git ignores is not an
    // exposure, and listing it in the failure would train people past it.
    expect(sweep).not.toThrow(/ignored\.yaml/);
  });

  it('finds nothing committable in the fixture project', () => {
    expect(() => sweepStrayPlaintext(fixtureCtx())).not.toThrow();
  });
});
