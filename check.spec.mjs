import { describe, expect, it } from 'vitest';
import { assertCiphertext, looksEncrypted } from './check.mjs';

const ENCRYPTED = `shared:
    TRIPGENCY_INTERNAL_API_KEY: ENC[AES256_GCM,data:abc==,iv:def=,tag:ghi==,type:str]
sops:
    age:
        - recipient: age1qqqq
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
    version: 3.9.4
`;

const PLAINTEXT = `shared:
    TRIPGENCY_INTERNAL_API_KEY: dev-tripgency-internal-api-key-change-me
`;

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
