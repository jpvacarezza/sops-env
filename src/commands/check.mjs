import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { projectEnv } from '../store/project.mjs';
import { secretsFilePath, WORKSPACE_ROOT } from '../store/paths.mjs';
import { APPS, ENVIRONMENTS } from '../scopes.mjs';

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

/** Files under `secrets/` that are tracked on purpose. */
export const TRACKED_SECRETS_FILES = ['README.md', 'STAGING-PROD-CHECKLIST.md'];

/**
 * Entries under `secrets/` that are neither a ciphertext file nor tracked prose.
 *
 * By the `.gitignore` comment's own definition, everything else in that
 * directory is a decrypted working copy, so this is the set to ask questions
 * about. It does not decide anything by itself: a stray that git ignores is a
 * developer mid-edit, and a stray git would take is the hole.
 */
export function strayEntries(entries, { environments = ENVIRONMENTS } = {}) {
  const expected = new Set([
    ...environments.map((environment) => `${environment}.enc.yaml`),
    ...TRACKED_SECRETS_FILES,
  ]);

  return entries.filter((entry) => !expected.has(entry)).sort();
}

/**
 * Whether git ignores `secrets/<entry>`: true, false, or null when git could
 * not answer.
 *
 * `git check-ignore --quiet` exits 0 for ignored and 1 for not ignored; any
 * other status, and a spawn error, mean the question went unanswered rather
 * than answered "no".
 */
function gitIgnores(entry, { root = WORKSPACE_ROOT } = {}) {
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', join('secrets', entry)],
    { cwd: root },
  );

  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Sweep `secrets/` for plaintext the index would accept.
 *
 * This exists because the deny-all in `.gitignore` is followed by
 * `!/secrets/*.enc.yaml`, and gitignore is last-match-wins: for a while that
 * negation re-included `secrets/.decrypted~local.enc.yaml`, the exact name SOPS
 * editor integrations write their decrypted buffer to. `checkCiphertextFiles`
 * could not see it, because `secretsFilePath` only ever returns the three
 * registered names — so the check that runs on every PR was blind to the one
 * file in the directory that was neither ciphertext nor ignored.
 *
 * A stray git cannot classify counts as committable. For a control whose whole
 * job is to prove nothing is exposed, "I could not tell" has to fail the same
 * way "it is exposed" does.
 *
 * Runs without an age key: it reads directory entries and asks git about paths,
 * never file contents.
 */
export function sweepStrayPlaintext({
  root = WORKSPACE_ROOT,
  entries,
  isIgnored = (entry) => gitIgnores(entry, { root }),
} = {}) {
  const directory = join(root, 'secrets');
  if (!entries && !existsSync(directory))
    return { committable: [], ignored: [] };

  // Always the full set, never the caller's subset. What is on disk does not
  // change because you asked about one environment, and taking a subset here
  // made `secrets:check local` report staging's and production's tracked
  // ciphertext as committable plaintext — a false alarm of the worst kind.
  const strays = strayEntries(entries ?? readdirSync(directory), {
    environments: ENVIRONMENTS,
  });

  const committable = [];
  const ignored = [];
  for (const entry of strays) {
    if (isIgnored(entry) === true) ignored.push(entry);
    else committable.push(entry);
  }

  if (committable.length > 0) {
    throw new Error(
      `secrets/ holds ${committable.length} file(s) git would accept into the ` +
        `index: ${committable.join(', ')}.\n` +
        'Everything under secrets/ other than the three *.enc.yaml files, ' +
        'README.md and STAGING-PROD-CHECKLIST.md is a decrypted working copy. ' +
        'Delete it, or add a pattern for it to .gitignore BELOW the ' +
        '`!/secrets/*.enc.yaml` negation — above it, the negation wins.',
    );
  }

  return { committable, ignored };
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
    // First, because a plaintext file the index would take outranks every other
    // finding here. Deliberately not scoped to `environments`: see the sweep.
    const { ignored } = sweepStrayPlaintext();
    for (const entry of ignored) {
      console.log(
        `Note: secrets/${entry} is a decrypted working copy. Git ignores it, ` +
          'so it is not exposed — delete it when you are done with it.',
      );
    }

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
