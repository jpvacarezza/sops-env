/**
 * Argument parsing and sops argv for `secrets:set` / `secrets:unset`.
 *
 * Pure, and separated from the writing for the same reason `sync-plan.mjs` is
 * separated from `sync.mjs`: every refusal in here has to be provable without a
 * key, a binary, or a file on disk, because a refusal that only works when sops
 * happens to be installed is not a control.
 */
import { ENVIRONMENTS, SCOPE_KEYS, SCOPES } from './scopes.mjs';

export const SET_USAGE = `Usage: <value on stdin> | pnpm secrets:set <environment|all> <scope> <KEY>
       pnpm secrets                          (the grid; needs a terminal)

  environment   ${ENVIRONMENTS.join(' | ')} | all
  scope         ${SCOPES.join(' | ')}
  KEY           must already be declared for that scope in tools/secrets/scopes.mjs
  --sync        after writing, dry-run \`secrets:sync\` for the app that scope
                feeds, then offer the real sync. Needs a terminal to confirm at;
                without one it stops after the dry run.

The value is read from stdin and never taken as an argument: on Windows any
process running as you can read another process's command line, and argv lands
in your shell history either way.

  printf '%s' "$NEW" | pnpm secrets:set staging api BETTER_AUTH_URL_ADMIN
  pnpm secrets:unset local api VENDOR_DATA_DIR`;

export const UNSET_USAGE = `Usage: pnpm secrets:unset <environment|all> <scope> <KEY>

  environment   ${ENVIRONMENTS.join(' | ')} | all
  scope         ${SCOPES.join(' | ')}
  KEY           must already be declared for that scope in tools/secrets/scopes.mjs

Takes no value and reads no stdin. \`--sync\` is refused here: the platform
providers only ever upsert, so a sync cannot delete anything and would report
success while the old value stayed live.

  pnpm secrets:unset local api VENDOR_DATA_DIR`;

/**
 * Positional only, and `all` has to be spelled out.
 *
 * `args.mjs` takes the same line on the `--` before a command: guessing wrong
 * here writes a real secret to an environment nobody named.
 */
export function parseSetArgs(argv, { usage = SET_USAGE } = {}) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));

  if (positional.length !== 3) {
    throw new Error(
      `Expected exactly 3 arguments, got ${positional.length}.\n\n${usage}`,
    );
  }

  const [target, scope, key] = positional;

  if (target !== 'all' && !ENVIRONMENTS.includes(target)) {
    throw new Error(
      `Unknown environment "${target}". Expected one of: ${ENVIRONMENTS.join(', ')}, or "all".`,
    );
  }

  if (!SCOPES.includes(scope)) {
    throw new Error(
      `Unknown scope "${scope}". Expected one of: ${SCOPES.join(', ')}.`,
    );
  }

  return {
    environments: target === 'all' ? [...ENVIRONMENTS] : [target],
    scope,
    key,
  };
}

/**
 * Refuse a key the registry does not declare for that scope, before any I/O.
 *
 * `scopes.mjs` calls itself the one security control in the projection path, and
 * a menu or a shell one-liner makes filing `DATABASE_URL` under `web:` *easier*
 * than the sops CLI does. This tool does not edit that file: the entry it wants
 * carries a comment explaining which audience the variable belongs to, and that
 * sentence is the reason the control works.
 */
export function assertWritable({ scope, key }, { registry = SCOPE_KEYS } = {}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(
      `Unknown scope "${scope}". Expected one of: ${SCOPES.join(', ')}.`,
    );
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(
      `"${key}" is not a variable name. Environment variables here are ` +
        'UPPER_SNAKE_CASE.',
    );
  }

  if ((registry[scope] ?? []).includes(key)) return;

  const elsewhere = SCOPES.filter((candidate) =>
    (registry[candidate] ?? []).includes(key),
  );

  const hint =
    elsewhere.length > 0
      ? `It is declared for ${elsewhere.map((s) => `"${s}"`).join(' and ')}. ` +
        'App scopes never merge — each one is a separate deployment — so a key ' +
        'that belongs to another audience is a different variable, not this one.'
      : 'It is declared for no scope at all.';

  throw new Error(
    `"${key}" is not declared for scope "${scope}". ${hint}\n` +
      'If it really belongs here, add it to SCOPE_KEYS.' +
      `${scope} in tools/secrets/scopes.mjs — with a comment saying why that ` +
      'audience — and run this again. Nothing was written.',
  );
}

/** The sops key path for one cell. */
export function sopsIndex(scope, key) {
  return `["${scope}"]["${key}"]`;
}

/**
 * argv for a write. Never a shell string.
 *
 * Two things are load-bearing. The value is JSON-encoded because that is what
 * `sops set` documents, and it is coerced to a string first: `JSON.stringify(6003)`
 * writes `type:int`, which `assertValidDocument` then rejects — but only at the
 * next `check --decrypt` or `sync`, long after the write looked fine.
 *
 * And this is an array, so no shell is involved. The PowerShell quoting hazard
 * `secrets/README.md` documents is a shell problem: measured through
 * `spawnSync(exe, [args])` on Windows, twelve hostile values — embedded quotes,
 * backslashes, newlines, a leading dash, `%VAR%` — all arrive byte-identical.
 */
export function setArgs(file, scope, key, value) {
  return ['set', file, sopsIndex(scope, key), JSON.stringify(String(value))];
}

/** argv for a removal. `--idempotent` so a key already gone is not an error. */
export function unsetArgs(file, scope, key) {
  return ['unset', '--idempotent', file, sopsIndex(scope, key)];
}

/**
 * What stdin gave us, with one trailing newline removed.
 *
 * `echo` adds one and `printf '%s'` does not, and a value that silently carries
 * a newline fails somewhere far away — a URL that will not parse, a key that
 * compares unequal to the same key typed elsewhere. Exactly one is stripped, so
 * a deliberately multi-line value keeps its shape, and the caller reports the
 * byte count either way so the strip is never invisible.
 */
export function normalizeStdin(raw) {
  const value = raw.replace(/\r?\n$/, '');

  return { value, strippedNewline: value.length !== raw.length };
}
