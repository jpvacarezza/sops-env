/**
 * Argument parsing and sops argv for `sops-env set` and `sops-env unset`.
 *
 * Pure, and separated from the writing for the same reason `sync-plan.mjs` is
 * separated from `sync.mjs`: every refusal in here has to be provable without a
 * key, a binary, or a file on disk, because a refusal that only works when sops
 * happens to be installed is not a control.
 */

export const setUsage = (
  ctx,
) => `Usage: <value on stdin> | sops-env set <environment|all> <scope> <KEY>
       sops-env                              (the grid; needs a terminal)

  environment   ${ctx.environments.join(' | ')} | all
  scope         ${ctx.scopes.join(' | ')}
  KEY           must already be declared for that scope in secrets.config.mjs
  --sync        after writing, dry-run \`sops-env sync\` for the app that scope
                feeds, then offer the real sync. Needs a terminal to confirm at;
                without one it stops after the dry run.

The value is read from stdin and is never an argument to sops-env: on Windows
any process running as you can read another process's command line, and argv
lands in your shell history either way. It reaches \`sops set\` only on that
child's stdin (\`--value-stdin\`, sops >= 3.11.0).

  printf '%s' "$NEW" | sops-env set staging api BETTER_AUTH_URL_ADMIN
  sops-env unset local api VENDOR_DATA_DIR`;

export const unsetUsage = (
  ctx,
) => `Usage: sops-env unset <environment|all> <scope> <KEY>

  environment   ${ctx.environments.join(' | ')} | all
  scope         ${ctx.scopes.join(' | ')}
  KEY           must already be declared for that scope in secrets.config.mjs

Takes no value and reads no stdin. \`--sync\` is refused here: the platform
providers only ever upsert, so a sync cannot delete anything and would report
success while the old value stayed live.

  sops-env unset local api VENDOR_DATA_DIR`;

/**
 * Positional only, and `all` has to be spelled out.
 *
 * `args.mjs` takes the same line on the `--` before a command: guessing wrong
 * here writes a real secret to an environment nobody named.
 */
export function parseSetArgs(ctx, argv, { usage = setUsage(ctx) } = {}) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));

  if (positional.length !== 3) {
    throw new Error(
      `Expected exactly 3 arguments, got ${positional.length}.\n\n${usage}`,
    );
  }

  const [target, scope, key] = positional;

  if (target !== 'all' && !ctx.environments.includes(target)) {
    throw new Error(
      `Unknown environment "${target}". Expected one of: ${ctx.environments.join(', ')}, or "all".`,
    );
  }

  if (!ctx.scopes.includes(scope)) {
    throw new Error(
      `Unknown scope "${scope}". Expected one of: ${ctx.scopes.join(', ')}.`,
    );
  }

  return {
    environments: target === 'all' ? [...ctx.environments] : [target],
    scope,
    key,
  };
}

/**
 * Refuse a key the registry does not declare for that scope, before any I/O.
 *
 * The registry in `secrets.config.mjs` is the one security control in the projection path, and
 * a menu or a shell one-liner makes filing `DATABASE_URL` under `web:` *easier*
 * than the sops CLI does. This tool does not edit that file: the entry it wants
 * carries a comment explaining which audience the variable belongs to, and that
 * sentence is the reason the control works.
 */
export function assertWritable(ctx, { scope, key }) {
  if (!ctx.scopes.includes(scope)) {
    throw new Error(
      `Unknown scope "${scope}". Expected one of: ${ctx.scopes.join(', ')}.`,
    );
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(
      `"${key}" is not a variable name. Environment variables here are ` +
        'UPPER_SNAKE_CASE.',
    );
  }

  if ((ctx.registry[scope] ?? []).includes(key)) return;

  const elsewhere = ctx.scopes.filter((candidate) =>
    (ctx.registry[candidate] ?? []).includes(key),
  );

  const hint =
    elsewhere.length > 0
      ? `It is declared for ${elsewhere.map((s) => `"${s}"`).join(' and ')}. ` +
        'App scopes never merge — each one is a separate deployment — so a key ' +
        'that belongs to another audience is a different variable, not this one.'
      : 'It is declared for no scope at all.';

  throw new Error(
    `"${key}" is not declared for scope "${scope}". ${hint}\n` +
      `If it really belongs here, add it under scopes.${scope}.keys in ` +
      'secrets.config.mjs — with a note saying why that audience — and run ' +
      'this again. Nothing was written.',
  );
}

/** The sops key path for one cell. */
export function sopsIndex(scope, key) {
  return `["${scope}"]["${key}"]`;
}

/**
 * argv for a write. Never a shell string, and never the value: that goes to
 * `sops set --value-stdin` through `setInput`, so it is not in any process listing.
 * No shell is involved either, which is what avoids the PowerShell quoting hazard
 * `secrets/README.md` documents.
 */
export function setArgs(file, scope, key) {
  return ['set', '--value-stdin', file, sopsIndex(scope, key)];
}

/**
 * The stdin for `setArgs`. JSON-encoded because that is what `sops set` expects,
 * and coerced to a string first: `JSON.stringify(6003)` writes `type:int`, which
 * `assertValidDocument` then rejects — but only at the next `check --decrypt` or
 * `sync`, long after the write looked fine.
 */
export function setInput(value) {
  return JSON.stringify(String(value));
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
