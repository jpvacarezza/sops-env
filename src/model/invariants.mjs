/**
 * Relations between two variables that no single variable's schema can express.
 *
 * `docs/ops/secrets.md` asks a human to keep the BFF→API key pairs in step, and
 * `apps/api/src/config/env.ts` refines that the two API-side keys differ — but
 * that refinement only sees the API's own projection, so it can prove
 * `WEB ≠ ADMIN` and can never prove `api.…_WEB == web.…`. Those live in
 * different scopes and reach different platforms. Nothing checked them until
 * this file.
 *
 * `checkPairs` takes a lookup returning an opaque token rather than reading
 * values itself, because equality is the only operation it needs and it has no
 * business holding anything more. Both callers happen to pass the real value
 * today — the grid through the closure `collect` hands it, the audit through the
 * decrypted document — and the safety comes from the other end: the results
 * carry `status` and `holds` and never a token, which `invariants.spec.mjs`
 * pins. The indirection is what makes that assertion possible to make.
 */

/** @typedef {{ scope: string, key: string }} Ref */

/**
 * Check every pair for one environment.
 *
 * `lookup(scope, key)` returns a token, or `undefined` when the variable is not
 * set. A pair with a missing side is reported as `unknown` rather than as a
 * violation: an unset variable is the other checks' business, and calling it a
 * mismatch here would report the same problem twice.
 */
export function checkPairs(ctx, lookup) {
  return ctx.pairs.map((pair) => {
    const left = lookup(pair.left.scope, pair.left.key);
    const right = lookup(pair.right.scope, pair.right.key);

    if (left === undefined || right === undefined) {
      return { ...pair, status: 'unknown', holds: null };
    }

    const equal = left === right;
    const holds = pair.relation === 'equal' ? equal : !equal;

    return { ...pair, status: holds ? 'ok' : 'violated', holds };
  });
}

/** Findings for the pairs that do not hold, in the shape `buildMatrix` emits. */
export function pairFindings(environment, results) {
  return results
    .filter((result) => result.status === 'violated')
    .map((result) => ({
      code: result.relation === 'equal' ? 'pair-mismatch' : 'pair-collision',
      severity: 'error',
      scope: result.left.scope,
      key: result.left.key,
      environment,
      message:
        `${result.name} does not hold in ${environment}: ` +
        `${result.left.scope}.${result.left.key} and ` +
        `${result.right.scope}.${result.right.key} must ` +
        `${result.relation === 'equal' ? 'match' : 'differ'}. ${result.why}`,
    }));
}

/**
 * Values that are obviously not real yet. A sentinel is a repo convention, so
 * the pattern is `ctx.placeholderPattern`.
 *
 * `{ scope, key }` for every value that still looks like a placeholder.
 */
export function findPlaceholders(ctx, document) {
  return Object.entries(document)
    .filter(([, entries]) => entries && typeof entries === 'object')
    .flatMap(([scope, entries]) =>
      Object.entries(entries)
        .filter(([, value]) => ctx.placeholderPattern.test(String(value)))
        .map(([key]) => ({ scope, key })),
    );
}

export function placeholderFindings(environment, placeholders) {
  return placeholders.map(({ scope, key }) => ({
    code: 'placeholder',
    severity: environment === 'local' ? 'warn' : 'error',
    scope,
    key,
    environment,
    message:
      `${scope}.${key} in ${environment} still holds a placeholder. ` +
      (environment === 'local'
        ? 'Local placeholders are deliberate, so this is a note.'
        : 'Replace it before this environment is synced.'),
  }));
}
