import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from './decrypt.mjs';
import { projectEnv } from './project.mjs';
import { secretsFilePath } from './paths.mjs';
import { APPS, ENVIRONMENTS } from './scopes.mjs';

/**
 * Whether a file is a SOPS document with encrypted values.
 *
 * Both halves are required. A `sops:` block alone is satisfied by a file whose
 * values were pasted back in plaintext under an old metadata block, which is
 * exactly the accident this check exists to catch, and the one that a reviewer
 * skimming a large diff is least likely to notice.
 */
export function looksEncrypted(text) {
  return /^sops:/m.test(text) && text.includes('ENC[');
}

export function assertCiphertext(text, file) {
  if (!looksEncrypted(text)) {
    throw new Error(
      `${file} is not encrypted. Never commit plaintext secrets — restore the ` +
        'encrypted version (`git checkout -- ' +
        `${file}\`) or re-encrypt with \`sops -e -i ${file}\`.`,
    );
  }
}

/**
 * Structure pass. Runs without any age key, so CI can enforce it on every PR:
 * it only reads bytes. The decryption pass below is what needs a key.
 */
export function checkCiphertextFiles({ environments = ENVIRONMENTS } = {}) {
  const checked = [];

  for (const environment of environments) {
    const file = secretsFilePath(environment);
    if (!existsSync(file)) continue;
    assertCiphertext(
      readFileSync(file, 'utf8'),
      `secrets/${environment}.enc.yaml`,
    );
    checked.push(environment);
  }

  return checked;
}

/**
 * Decryption pass: the document parses, every key is declared in the registry,
 * and each app projects without collision. Only the key names are printed.
 */
export function checkDecryptable(environment) {
  const doc = decryptSecretsFile(secretsFilePath(environment));
  return Object.fromEntries(
    APPS.map((app) => [app, Object.keys(projectEnv(doc, app)).sort()]),
  );
}

export function main(argv = process.argv.slice(2)) {
  const withDecrypt = argv.includes('--decrypt');
  const requested = argv.filter((arg) => !arg.startsWith('--'));
  const environments = requested.length > 0 ? requested : ENVIRONMENTS;

  try {
    const checked = checkCiphertextFiles({ environments });

    if (checked.length === 0) {
      console.log(
        'No secrets/*.enc.yaml files yet — run `pnpm secrets:init` and ' +
          '`pnpm secrets:edit local` to create the first one.',
      );
      return 0;
    }

    console.log(`Encrypted: ${checked.join(', ')}`);

    if (withDecrypt) {
      for (const environment of checked) {
        const projections = checkDecryptable(environment);
        for (const [app, keys] of Object.entries(projections)) {
          console.log(
            `  ${environment}/${app}: ${keys.length} keys — ${keys.join(', ')}`,
          );
        }
      }
    }

    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
