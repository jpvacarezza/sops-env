import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { projectEnv } from '../store/project.mjs';
import { secretsFilePath, storeDir } from '../store/paths.mjs';

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
 * Entries under the store directory that are neither a ciphertext file nor
 * tracked prose (`ctx.store.tracked`).
 *
 * By the `.gitignore` comment's own definition, everything else in that
 * directory is a decrypted working copy, so this is the set to ask questions
 * about. It does not decide anything by itself: a stray that git ignores is a
 * developer mid-edit, and a stray git would take is the hole.
 */
export function strayEntries(ctx, entries) {
  const expected = new Set([
    ...ctx.environments.map((environment) =>
      ctx.store.file.replace('<environment>', environment),
    ),
    ...ctx.store.tracked,
  ]);

  return entries.filter((entry) => !expected.has(entry)).sort();
}

/**
 * Whether git ignores `<store.dir>/<entry>`: true, false, or null when git could
 * not answer.
 *
 * `git check-ignore --quiet` exits 0 for ignored and 1 for not ignored; any
 * other status, and a spawn error, mean the question went unanswered rather
 * than answered "no".
 */
function gitIgnores(ctx, entry) {
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', join(ctx.store.dir, entry)],
    { cwd: ctx.root },
  );

  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Sweep the store directory for plaintext the index would accept.
 *
 * This exists because the deny-all in `.gitignore` is followed by a negation
 * for the ciphertext files, and gitignore is last-match-wins: for a while that
 * negation re-included `.decrypted~local.enc.yaml`, the exact name SOPS
 * editor integrations write their decrypted buffer to. `checkCiphertextFiles`
 * could not see it, because `secretsFilePath` only ever returns the registered
 * names — so the check that runs on every PR was blind to the one file in the
 * directory that was neither ciphertext nor ignored.
 *
 * A stray git cannot classify counts as committable. For a control whose whole
 * job is to prove nothing is exposed, "I could not tell" has to fail the same
 * way "it is exposed" does.
 *
 * Runs without an age key: it reads directory entries and asks git about paths,
 * never file contents.
 */
export function sweepStrayPlaintext(
  ctx,
  { entries, isIgnored = (entry) => gitIgnores(ctx, entry) } = {},
) {
  const directory = storeDir(ctx);
  if (!entries && !existsSync(directory))
    return { committable: [], ignored: [] };

  // Always the full set, never the caller's subset. What is on disk does not
  // change because you asked about one environment, and taking a subset here
  // made `check local` report the other environments' tracked ciphertext as
  // committable plaintext — a false alarm of the worst kind.
  const strays = strayEntries(ctx, entries ?? readdirSync(directory));

  const committable = [];
  const ignored = [];
  for (const entry of strays) {
    if (isIgnored(entry) === true) ignored.push(entry);
    else committable.push(entry);
  }

  if (committable.length > 0) {
    const pattern = ctx.store.file.replace('<environment>', '*');
    throw new Error(
      `${ctx.store.dir}/ holds ${committable.length} file(s) git would accept into the ` +
        `index: ${committable.join(', ')}.\n` +
        `Everything under ${ctx.store.dir}/ other than the ${ctx.environments.length} ${pattern} files ` +
        `and ${ctx.store.tracked.join(', ')} is a decrypted working copy. ` +
        'Delete it, or add a pattern for it to .gitignore BELOW the ' +
        `\`!/${ctx.store.dir}/${pattern}\` negation — above it, the negation wins.`,
    );
  }

  return { committable, ignored };
}

/**
 * Structure pass. Runs without any age key, so CI can enforce it on every PR:
 * it only reads bytes. The decryption pass below is what needs a key.
 */
export function checkCiphertextFiles(
  ctx,
  { environments = ctx.environments } = {},
) {
  const checked = [];

  for (const environment of environments) {
    const file = secretsFilePath(ctx, environment);
    if (!existsSync(file)) continue;
    assertCiphertext(readFileSync(file, 'utf8'), ctx.relative(file));
    checked.push(environment);
  }

  return checked;
}

/**
 * Decryption pass: the document parses, every key is declared in the registry,
 * and each app projects without collision. Only the key names are printed.
 */
export function checkDecryptable(ctx, environment) {
  const doc = decryptSecretsFile(secretsFilePath(ctx, environment));
  return Object.fromEntries(
    ctx.apps.map((app) => [app, Object.keys(projectEnv(ctx, doc, app)).sort()]),
  );
}

export function main(ctx, argv) {
  const withDecrypt = argv.includes('--decrypt');
  const requested = argv.filter((arg) => !arg.startsWith('--'));
  const environments = requested.length > 0 ? requested : ctx.environments;

  try {
    // First, because a plaintext file the index would take outranks every other
    // finding here. Deliberately not scoped to `environments`: see the sweep.
    const { ignored } = sweepStrayPlaintext(ctx);
    for (const entry of ignored) {
      console.log(
        `Note: ${ctx.store.dir}/${entry} is a decrypted working copy. Git ignores it, ` +
          'so it is not exposed — delete it when you are done with it.',
      );
    }

    const checked = checkCiphertextFiles(ctx, { environments });

    if (checked.length === 0) {
      console.log(
        `No ${ctx.store.dir}/${ctx.store.file.replace('<environment>', '*')} files yet — run \`sops-env init\` and ` +
          `\`sops-env edit ${ctx.environments[0]}\` to create the first one.`,
      );
      return 0;
    }

    console.log(`Encrypted: ${checked.join(', ')}`);

    if (withDecrypt) {
      for (const environment of checked) {
        const projections = checkDecryptable(ctx, environment);
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
