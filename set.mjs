/**
 * `pnpm secrets:set` / `pnpm secrets:unset` — change one variable, per cell.
 *
 * Per cell and never by rewriting the document, for two measured reasons.
 * `sops -d --output-type json` cannot represent the encrypted `type:comment`
 * lines staging and production each open with, so a decrypt-modify-reencrypt
 * pass deletes them silently. And `sops -e -i` re-encrypts every value with a
 * fresh IV, which destroys the review property `secrets/README.md` names as the
 * approval criterion for this directory: three changed lines per edit — the key,
 * `lastmodified`, `mac` — and any fourth line is a real change to a value.
 *
 * Measured on sops 3.9.4: `sops set` of a different value touches exactly 3
 * lines and leaves the other 18 ENC[ blobs byte-identical, because sops reuses a
 * value's IV within one process when the plaintext is unchanged.
 *
 * There is no transaction across files. Writing three environments is three sops
 * invocations, so the safety net is that `git checkout -- secrets/` is a clean
 * undo — which only holds if the directory started clean, hence the refusal.
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile, INSTALL_HINT } from './decrypt.mjs';
import { runGuided } from './guided.mjs';
import { secretsFilePath, WORKSPACE_ROOT } from './paths.mjs';
import { assertValidDocument } from './project.mjs';
import { ask, parseConfirm } from './prompt.mjs';
import { APPS, SCOPE_KEYS } from './scopes.mjs';
import {
  assertWritable,
  normalizeStdin,
  parseSetArgs,
  setArgs,
  SET_USAGE,
  unsetArgs,
  UNSET_USAGE,
} from './set-plan.mjs';

function defaultRunSops(args) {
  return spawnSync('sops', args, { encoding: 'utf8', cwd: WORKSPACE_ROOT });
}

function defaultRunGit(args) {
  return spawnSync('git', args, { encoding: 'utf8', cwd: WORKSPACE_ROOT });
}

/**
 * Refuse to start with `secrets/` already dirty.
 *
 * The undo for a partial write is `git checkout -- secrets/`, and with someone
 * else's uncommitted change sitting there that undo throws their work away too.
 * Refusing is also the only honest answer to "which of these edits was mine".
 */
export function assertCleanSecrets({ runGit = defaultRunGit } = {}) {
  const result = runGit(['status', '--porcelain', '--', 'secrets']);

  if (result.error || result.status !== 0) {
    throw new Error(
      'Could not ask git whether secrets/ is clean, so the undo for a partial ' +
        `write cannot be relied on. ${result.error?.message ?? (result.stderr || '').trim()}`,
    );
  }

  const dirty = (result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

  if (dirty.length > 0) {
    throw new Error(
      `secrets/ has uncommitted changes:\n${dirty.map((line) => `  ${line}`).join('\n')}\n` +
        'This writes one file at a time with no transaction, so ' +
        '`git checkout -- secrets/` is the undo — and it would take those ' +
        'changes with it. Commit or discard them first.',
    );
  }
}

/** Read all of stdin. Refuses a terminal, which would otherwise just hang. */
export function readStdin(stream = process.stdin) {
  if (stream.isTTY) {
    return Promise.reject(
      new Error(
        `No value on stdin.\n\n${SET_USAGE}\n\nStdin is a terminal, so this ` +
          'would have waited forever. Pipe the value in.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      raw += chunk;
    });
    stream.on('end', () => resolve(raw));
    stream.on('error', reject);
  });
}

/**
 * Write or remove one variable in one environment.
 *
 * `assertValidDocument` runs on the *mutated* document, before the write, which
 * is what makes it a gate rather than a health check. It also refuses to write
 * into a document that was already invalid — fix that first, or unset the
 * offending key, which is itself a mutation that makes the document valid.
 *
 * The read-back is not ceremony: `sops set` reports success for a value it
 * coerced, and a silent type change surfaces much later as a Zod failure at boot.
 */
export function writeCell(
  { environment, scope, key, value, mode = 'set' },
  {
    runSops = defaultRunSops,
    decrypt = decryptSecretsFile,
    registry = SCOPE_KEYS,
  } = {},
) {
  assertWritable({ scope, key }, { registry });

  const file = secretsFilePath(environment);
  const shown = relative(WORKSPACE_ROOT, file).split('\\').join('/');
  const document = decrypt(file);

  const next = { ...document, [scope]: { ...(document[scope] ?? {}) } };
  if (mode === 'unset') delete next[scope][key];
  else next[scope][key] = String(value);

  assertValidDocument(next, { registry });

  const args =
    mode === 'unset'
      ? unsetArgs(file, scope, key)
      : setArgs(file, scope, key, value);
  const result = runSops(args);

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`\`sops\` was not found on PATH. ${INSTALL_HINT}`);
    }
    throw new Error(`Could not run \`sops\`: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `\`sops ${args[0]} ${shown}\` failed with exit code ${result.status}.\n` +
        `${(result.stderr || '').trim()}`,
    );
  }

  const written = decrypt(file)[scope]?.[key];
  if (mode === 'unset') {
    if (written !== undefined) {
      throw new Error(
        `\`sops unset\` reported success but ${scope}.${key} is still present ` +
          `in ${shown}.`,
      );
    }
  } else if (written !== String(value)) {
    throw new Error(
      `\`sops set\` reported success but reading ${scope}.${key} back from ` +
        `${shown} did not return what was written. The value may have been ` +
        'coerced; do not trust this file until you have looked at it.',
    );
  }

  // `unset --idempotent` on an absent key is deliberate and touches nothing, so
  // reporting "unset X" for it claims a change that did not happen.
  const before = document[scope]?.[key];
  const changed =
    mode === 'unset' ? before !== undefined : before !== String(value);

  return { environment, file: shown, mode, changed, key: `${scope}.${key}` };
}

/**
 * Preflight, then apply one environment at a time.
 *
 * The preflight decrypts every target before touching any of them, so the common
 * failure — no age key for production — is caught before local and staging have
 * already been written and the set is half-applied.
 */
export function writeAcrossEnvironments(
  { environments, scope, key, value, values, mode = 'set' },
  { decrypt = decryptSecretsFile, registry = SCOPE_KEYS, ...seams } = {},
) {
  assertWritable({ scope, key }, { registry });

  // `values` is a per-environment map, which is what the guided form produces:
  // it asks once per environment rather than offering one value for all three,
  // because docs/ops/secrets.md says in as many words never to reuse a staging
  // key in production.
  const valueFor = (environment) => (values ? values[environment] : value);

  // The preflight decrypts every target *and* validates the document each write
  // would produce. Decrypting alone was not enough: an already-invalid
  // production document — an undeclared key someone added by hand — is refused
  // per-cell, so `secrets:set all` wrote local and staging and then stopped,
  // which is the half-applied state this preflight exists to prevent. The
  // documents are decrypted here anyway, so checking them costs nothing.
  const unreadable = [];
  const invalid = [];
  for (const environment of environments) {
    let document;
    try {
      document = decrypt(secretsFilePath(environment));
    } catch (error) {
      unreadable.push(`${environment}: ${error.message.split('\n')[0]}`);
      continue;
    }

    const next = { ...document, [scope]: { ...(document[scope] ?? {}) } };
    if (mode === 'unset') delete next[scope][key];
    else next[scope][key] = String(valueFor(environment));

    try {
      assertValidDocument(next, { registry });
    } catch (error) {
      invalid.push(
        `${environment}: ${error.message.split('\n').slice(1).join(' ').trim()}`,
      );
    }
  }

  if (unreadable.length + invalid.length > 0) {
    const reasons = [...unreadable, ...invalid].map((line) => `  ${line}`);

    throw new Error(
      `Refusing to write anything, because ${reasons.length} of ` +
        `${environments.length} target environment(s) would not go through:\n` +
        `${reasons.join('\n')}\n` +
        'Writing the rest would leave the set half-applied across files that ' +
        'have no shared marker to tell you so.',
    );
  }

  const applied = [];
  for (const environment of environments) {
    try {
      applied.push(
        writeCell(
          { environment, scope, key, value: valueFor(environment), mode },
          { decrypt, registry, ...seams },
        ),
      );
    } catch (error) {
      return {
        applied,
        failed: { environment, message: error.message },
      };
    }
  }

  return { applied, failed: null };
}

/** `git diff -w --numstat -- secrets/`, the repo's documented review step. */
export function secretsDiffStat({ runGit = defaultRunGit } = {}) {
  const result = runGit(['diff', '-w', '--numstat', '--', 'secrets']);
  if (result.error || result.status !== 0) return [];

  return (result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

function defaultRunSync(args) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./sync.mjs', import.meta.url)), ...args],
    { encoding: 'utf8', cwd: WORKSPACE_ROOT, stdio: 'inherit' },
  );
}

/**
 * Dry-run the sync for what was just written, then offer the real one.
 *
 * Never unattended. A sync writes to a live Vercel or Railway project, and the
 * confirmation is the only thing between a typo and production; with no terminal
 * to confirm at, this stops after the dry run and prints the command instead.
 * `local` is filtered out because `secrets:sync` refuses it by design.
 */
export async function offerSync(
  { environments, scope },
  { runSync = defaultRunSync, input = process.stdin } = {},
) {
  const targets = environments.filter((name) => name !== 'local');
  if (targets.length === 0) return 0;

  // Only the app the scope actually feeds. `shared` merges into all three.
  const app = APPS.includes(scope) ? scope : 'all';

  for (const environment of targets) {
    console.log(`\n$ pnpm secrets:sync ${environment} ${app} --dry-run`);
    const dry = runSync([environment, app, '--dry-run']);
    if (dry.error || dry.status !== 0) {
      console.error(
        `The dry run failed, so nothing was synced. ${dry.error?.message ?? ''}`,
      );
      return 1;
    }
  }

  if (!input.isTTY) {
    console.log(
      '\nStopping after the dry run: there is no terminal to confirm at. Run ' +
        `the same commands without --dry-run when you are ready.`,
    );
    return 0;
  }

  const confirmed = parseConfirm(
    await ask('\nRun the real sync now? (y/N) > '),
  );
  if (!confirmed) {
    console.log('Not synced. The ciphertext is written either way.');
    return 0;
  }

  for (const environment of targets) {
    console.log(`\n$ pnpm secrets:sync ${environment} ${app}`);
    const real = runSync([environment, app]);
    if (real.error || real.status !== 0) {
      console.error(`Sync failed for ${environment}.`);
      return 1;
    }
  }

  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  { mode = 'set' } = {},
) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const usage = mode === 'unset' ? UNSET_USAGE : SET_USAGE;

  for (const flag of flags) {
    if (!['--sync', '--help'].includes(flag)) {
      console.error(`Unknown flag "${flag}".\n\n${usage}`);
      return 1;
    }
  }

  if (flags.includes('--help')) {
    console.log(usage);
    return 0;
  }

  // The platform providers only ever upsert — Vercel POSTs the keys present with
  // `?upsert=true`, and Railway's `variableCollectionUpsert` runs with `replace`
  // false so it deletes nothing. So a sync after an unset would print
  // "upserted N keys" while the removed value stayed live indefinitely.
  if (mode === 'unset' && flags.includes('--sync')) {
    console.error(
      'Refusing `--sync` on an unset. Vercel and Railway are only ever upserted ' +
        'here, so a sync cannot delete anything: it would report success while ' +
        'the old value stayed live on the platform. Remove it in the dashboard, ' +
        'then the ciphertext and the platform agree again.',
    );
    return 1;
  }

  try {
    assertCleanSecrets();
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  // No arguments means the guided form: the hard part was never the syntax, it
  // was knowing which variable lives in which scope and which environments
  // already have it.
  const guided = mode === 'set' && positional.length === 0;

  // Without a terminal the form has nobody to ask, and the failure mode is
  // silent: readline sees EOF, nothing is written, and the process exits 0.
  if (guided && !process.stdin.isTTY) {
    console.error(
      `No arguments and no terminal.\n\n${SET_USAGE}\n\nThe guided form needs a ` +
        'terminal to ask at. In a script or a pipe, name the target and pipe ' +
        'the value.',
    );
    return 1;
  }

  let target;
  let value = null;
  let values = null;

  if (guided) {
    try {
      const chosen = await runGuided();
      if (!chosen) return 0;
      target = {
        environments: chosen.environments,
        scope: chosen.scope,
        key: chosen.key,
      };
      values = chosen.values;
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  } else {
    try {
      target = parseSetArgs(argv, { usage });
      assertWritable(target);
    } catch (error) {
      console.error(error.message);
      return 1;
    }

    if (mode === 'set') {
      try {
        const raw = await readStdin();
        const normalized = normalizeStdin(raw);
        value = normalized.value;

        if (value === '') {
          console.error(
            'Refusing to write an empty value. An empty string and an unset ' +
              'variable mean different things to the schemas — several treat "" ' +
              'as absent — so say which you meant: pipe a real value, or use ' +
              '`pnpm secrets:unset`.',
          );
          return 1;
        }

        console.log(
          `Read ${Buffer.byteLength(value, 'utf8')} bytes from stdin` +
            (normalized.strippedNewline ? ', trailing newline stripped' : ''),
        );
      } catch (error) {
        console.error(error.message);
        return 1;
      }
    }
  }

  try {
    const { applied, failed } = writeAcrossEnvironments({
      ...target,
      value,
      values,
      mode,
    });

    for (const entry of applied) {
      console.log(
        entry.changed
          ? `  ${entry.mode} ${entry.key} in ${entry.file}`
          : `  ${entry.key} in ${entry.file} was already that; nothing changed`,
      );
    }

    if (failed) {
      console.error(
        `Failed on ${failed.environment}: ${failed.message}\n` +
          `${applied.length} environment(s) were already written. There is no ` +
          'transaction across files — `git diff -- secrets/` shows what changed ' +
          'and `git checkout -- secrets/` undoes all of it.',
      );
      return 1;
    }

    const stat = secretsDiffStat();
    if (stat.length > 0) {
      console.log('\ngit diff -w --numstat -- secrets/');
      for (const line of stat) console.log(`  ${line}`);
      console.log(
        '  Expect 3 3 per file for a changed value, and 3 2 for a new key: the ' +
          'key, lastmodified and mac. A fourth changed line is another value.',
      );
    }

    if (flags.includes('--sync')) {
      return offerSync(target);
    }

    const remaining = target.environments.filter((name) => name !== 'local');
    if (remaining.length > 0) {
      const app = APPS.includes(target.scope) ? target.scope : 'all';
      console.log(
        `\nNext, when you want the platforms to see it:\n${remaining
          .map((name) => `  pnpm secrets:sync ${name} ${app} --dry-run`)
          .join('\n')}`,
      );
    }

    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
