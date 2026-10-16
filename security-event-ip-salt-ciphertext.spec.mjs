import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { secretsFilePath } from './paths.mjs';

/**
 * Key names in a SOPS document are plaintext; only values are ENC[…]. CI runs
 * `secrets:check` without an age key, so this is the gate that staging and
 * production actually declare SECURITY_EVENT_IP_SALT — distinct HMAC keys,
 * never the local placeholder — without decrypting.
 */
function declaresEncryptedKey(text, key) {
  return new RegExp(`^\\s+${key}:\\s+ENC\\[`, 'm').test(text);
}

describe('SECURITY_EVENT_IP_SALT in staging/production ciphertext', () => {
  for (const environment of ['staging', 'production']) {
    it(`declares SECURITY_EVENT_IP_SALT under api in ${environment}`, () => {
      const text = readFileSync(secretsFilePath(environment), 'utf8');

      expect(declaresEncryptedKey(text, 'SECURITY_EVENT_IP_SALT')).toBe(true);
    });
  }
});
