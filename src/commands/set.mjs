/**
 * `sops-env set` / `sops-env unset` — change one variable, per cell.
 *
 * Per cell and never by rewriting the document, for two measured reasons.
 * `sops -d --output-type json` cannot represent the encrypted `type:comment`
 * lines staging and production each open with, so a decrypt-modify-reencrypt
 * pass deletes them silently. And `sops -e -i` re-encrypts every value with a
 * fresh IV, which destroys the review property the store directory's README names as the
 * approval criterion for this directory: three changed lines per edit — the key,
 * `lastmodified`, `mac` — and any fourth line is a real change to a value.
 *
 * Measured on sops 3.9.4: `sops set` of a different value touches exactly 3
 * lines and leaves the other 18 ENC[ blobs byte-identical, because sops reuses a
 * value's IV within one process when the plaintext is unchanged.
 *
 * There is no transaction across files. Writing three environments is three sops
 * invocations, so the safety net is that `git checkout -- <store.dir>/` is a clean
 * undo — which only holds if the directory started clean, hence the refusal.
 */
import { spawnSync } from 'node:child_process';

import { decryptSecretsFile, INSTALL_HINT } from '../store/decrypt.mjs';
import { secretsFilePath } from '../store/paths.mjs';
import { assertValidDocument } from '../store/project.mjs';
import { ask, parseConfirm } from '../ui/prompt.mjs';
import { main as syncMain } from './sync.mjs';
import {
  assertWritable,
  normalizeStdin,
  parseSetArgs,
  setArgs,
  setUsage,
  unsetArgs,
  unsetUsage,
} from '../model/set-plan.mjs';

const defaultRunSops = (ctx, args) =>
  spawnSync('sops', args, { encoding: 'utf8', cwd: ctx.root });

const defaultRunGit = (ctx, args) =>
  spawnSync('git', args, { encoding: 'utf8', cwd: ctx.root });

/**
 * Refuse to start with the store directory already dirty.
 *
 * The undo for a partial write is `git checkout -- <store.dir>/`, and with someone
 * else's uncommitted change sitting there that undo throws their work away too.
 * Refusing is also the only honest answer to "which of these edits was mine".
 */
export function assertCleanSecrets(ctx, { runGit = defaultRunGit } = {}) {
  const result = runGit(ctx, ['status', '--porcelain', '--', ctx.store.dir]);

  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not ask git whether ${ctx.store.dir}/ is clean, so the undo for a partial ` +
        `write cannot be relied on. ${result.error?.message ?? (result.stderr || '').trim()}`,
    );
  }

  const dirty = (result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

  if (dirty.length > 0) {
    throw new Error(
      `${ctx.store.dir}/ has uncommitted changes:\n${dirty.map((line) => `  ${line}`).join('\n')}\n` +
        'This writes one file at a time with no transaction, so ' +
        `\`git checkout -- ${ctx.store.dir}/\` is the undo — and it would take those ` +
        'changes with it. Commit or discard them first.',
    );
  }
}

/** Read all of stdin. Refuses a terminal, which would otherwise just hang. */
export function readStdin(ctx, stream = process.stdin) {
  if (stream.isTTY) {
    return Promise.reject(
      new Error(
        `No value on stdin.\n\n${setUsage(ctx)}\n\nStdin is a terminal, so this ` +
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
  ctx,
  { environment, scope, key, value, mode = 'set' },
  { runSops = defaultRunSops, decrypt = decryptSecretsFile } = {},
) {
  assertWritable(ctx, { scope, key });

  const file = secretsFilePath(ctx, environment);
  const shown = ctx.relative(file);
  const document = decrypt(file);

  const next = { ...document, [scope]: { ...(document[scope] ?? {}) } };
  if (mode === 'unset') delete next[scope][key];
  else next[scope][key] = String(value);

  assertValidDocument(ctx, next);

  const args =
    mode === 'unset'
      ? unsetArgs(file, scope, key)
      : setArgs(file, scope, key, value);
  const result = runSops(ctx, args);

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
  ctx,
  { environments, scope, key, value, values, mode = 'set' },
  { decrypt = decryptSecretsFile, ...seams } = {},
) {
  assertWritable(ctx, { scope, key });

  // `values` is a per-environment map, which is what the grid produces: it asks
  // once per environment rather than offering one value for all three, because
  // never reuse a staging key in
  // production.
  const valueFor = (environment) => (values ? values[environment] : value);

  // The preflight decrypts every target *and* validates the document each write
  // would produce. Decrypting alone was not enough: an already-invalid
  // production document — an undeclared key someone added by hand — is refused
  // per-cell, so `set all` wrote local and staging and then stopped,
  // which is the half-applied state this preflight exists to prevent. The
  // documents are decrypted here anyway, so checking them costs nothing.
  const unreadable = [];
  const invalid = [];
  for (const environment of environments) {
    let document;
    try {
      document = decrypt(secretsFilePath(ctx, environment));
    } catch (error) {
      unreadable.push(`${environment}: ${error.message.split('\n')[0]}`);
      continue;
    }

    const next = { ...document, [scope]: { ...(document[scope] ?? {}) } };
    if (mode === 'unset') delete next[scope][key];
    else next[scope][key] = String(valueFor(environment));

    try {
      assertValidDocument(ctx, next);
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
          ctx,
          { environment, scope, key, value: valueFor(environment), mode },
          { decrypt, ...seams },
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

/** `git diff -w --numstat -- <store.dir>/`, the documented review step. */
export function secretsDiffStat(ctx, { runGit = defaultRunGit } = {}) {
  const result = runGit(ctx, ['diff', '-w', '--numstat', '--', ctx.store.dir]);
  if (result.error || result.status !== 0) return [];

  return (result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/** In-process: the sync command is a function now, so no child process and no second config load. */
const defaultRunSync = (ctx, args) => syncMain(ctx, args);

/**
 * Dry-run the sync for what was just written, then offer the real one.
 *
 * Never unattended. A sync writes to a live Vercel or Railway project, and the
 * confirmation is the only thing between a typo and production; with no terminal
 * to confirm at, this stops after the dry run and prints the command instead.
 * Environments that do not sync are filtered out: `sync` refuses them by design.
 */
export async function offerSync(
  ctx,
  { environments, scope },
  {
    runSync = defaultRunSync,
    input = process.stdin,
    output = process.stdout,
  } = {},
) {
  const targets = environments.filter((name) => ctx.syncable.includes(name));
  if (targets.length === 0) return 0;

  // Only the app the scope actually feeds. `shared` merges into all three.
  const app = ctx.apps.includes(scope) ? scope : 'all';

  for (const environment of targets) {
    console.log(`\n$ sops-env sync ${environment} ${app} --dry-run`);
    const code = await runSync(ctx, [environment, app, '--dry-run']);
    if (code !== 0) {
      console.error('The dry run failed, so nothing was synced.');
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
    await ask('\nRun the real sync now? (y/N) > ', { input, output }),
  );
  if (!confirmed) {
    console.log('Not synced. The ciphertext is written either way.');
    return 0;
  }

  for (const environment of targets) {
    console.log(`\n$ sops-env sync ${environment} ${app}`);
    if ((await runSync(ctx, [environment, app])) !== 0) {
      console.error(`Sync failed for ${environment}.`);
      return 1;
    }
  }

  return 0;
}

export async function main(ctx, argv, { mode = 'set' } = {}) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const usage = mode === 'unset' ? unsetUsage(ctx) : setUsage(ctx);

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
    assertCleanSecrets(ctx);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  // This used to run a linear guided form here. `sops-env` with no arguments replaced it: the
  // grid shows which variable lives in which scope and which environments have
  // it, which was the actual difficulty, and it does not end after one write.
  if (positional.length === 0) {
    console.error(
      `Nothing to write.\n\n${usage}\n\nTo pick a variable interactively, run ` +
        '`sops-env` — the grid, with the same write path underneath.',
    );
    return 1;
  }

  let target;
  let value = null;

  try {
    target = parseSetArgs(ctx, argv, { usage });
    assertWritable(ctx, target);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (mode === 'set') {
    try {
      const raw = await readStdin(ctx);
      const normalized = normalizeStdin(raw);
      value = normalized.value;

      if (value === '') {
        console.error(
          'Refusing to write an empty value. An empty string and an unset ' +
            'variable mean different things to the schemas — several treat "" ' +
            'as absent — so say which you meant: pipe a real value, or use ' +
            '`sops-env unset`.',
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

  try {
    const { applied, failed } = writeAcrossEnvironments(ctx, {
      ...target,
      value,
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
          `transaction across files — \`git diff -- ${ctx.store.dir}/\` shows what changed ` +
          `and \`git checkout -- ${ctx.store.dir}/\` undoes all of it.`,
      );
      return 1;
    }

    const stat = secretsDiffStat(ctx);
    if (stat.length > 0) {
      console.log(`\ngit diff -w --numstat -- ${ctx.store.dir}/`);
      for (const line of stat) console.log(`  ${line}`);
      console.log(
        '  Expect 3 3 per file for a changed value, and 3 2 for a new key: the ' +
          'key, lastmodified and mac. A fourth changed line is another value.',
      );
    }

    if (flags.includes('--sync')) {
      return offerSync(ctx, target);
    }

    const remaining = target.environments.filter((name) =>
      ctx.syncable.includes(name),
    );
    if (remaining.length > 0) {
      const app = ctx.apps.includes(target.scope) ? target.scope : 'all';
      console.log(
        `\nNext, when you want the platforms to see it:\n${remaining
          .map((name) => `  sops-env sync ${name} ${app} --dry-run`)
          .join('\n')}`,
      );
    }

    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
