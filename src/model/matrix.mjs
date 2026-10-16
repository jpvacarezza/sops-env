/**
 * Crosses the four things that describe a variable into one grid.
 *
 * The sources are the scope registry, what each ciphertext file actually
 * declares, and how each app's Zod schema declares it. `env-contract.spec.mjs`
 * already compares those lists by *name* and passes today — while
 * `BETTER_AUTH_URL_ADMIN`, required with no default, is set in `local` and
 * missing from staging and production. Name parity cannot see that, because it
 * is a question about presence per environment. This is that question.
 *
 * Pure. It never receives a decrypted value: a caller that wants to show which
 * cells hold the same secret passes precomputed fingerprints, so "no value
 * reaches the model" is structural rather than a rule someone has to remember.
 */

/** Apps that receive a scope's variables. `shared` merges into all of them. */
export function receivingApps(ctx, scope) {
  return Object.entries(ctx.appScopes)
    .filter(([, scopes]) => scopes.includes(scope))
    .map(([app]) => app);
}

/**
 * The schema entry that governs a variable, and the app whose schema it is.
 *
 * A scope maps to its own app. `shared` has no single owner, so the first app
 * that declares the key wins — enough to render a marker, and `shared` is empty
 * on purpose today (the config explains why the internal keys
 * are per consumer).
 */
function schemaFor(ctx, scope, key, declarations) {
  const candidates = ctx.apps.includes(scope) ? [scope] : ctx.apps;

  for (const app of candidates) {
    const declaration = declarations[app]?.[key];
    if (declaration) return { app, ...declaration };
  }

  return null;
}

/**
 * Errors and warnings in a finding list.
 *
 * Exported because callers append findings of their own — the grid adds the
 * cross-scope invariants after the fact — and a `counts` computed once at
 * construction then disagrees with `findings`. A script gating on `counts.error`
 * would read 0 next to a real error.
 */
export function countBySeverity(findings) {
  return {
    error: findings.filter((finding) => finding.severity === 'error').length,
    warn: findings.filter((finding) => finding.severity === 'warn').length,
  };
}

export function buildMatrix(
  ctx,
  { environments, inventories, declarations = {}, fingerprints = {} },
) {
  const registry = ctx.registry;
  const exemptions = ctx.notDriftWhenUnset;
  const findings = [];
  const totals = { set: 0, unset: 0, undeclared: 0 };

  const scopes = ctx.scopes.map((scope) => {
    const declared = registry[scope] ?? [];

    // An app scope with no platform to deploy to — `ingest` until slice 1b —
    // has no `staging` or `production` to be missing a required key FROM.
    // Restricting the finding to `local` is what keeps `missing-required`
    // meaning "the app cannot boot", not "an environment nothing ever
    // populates is empty". `shared` is exempt from this: it is not in `APPS`,
    // so it always keeps the full environment list, because it merges into
    // apps that ARE deployable.
    const scopeEnvironments =
      ctx.apps.includes(scope) && !ctx.deployableApps.includes(scope)
        ? environments.filter((environment) => environment === 'local')
        : environments;

    // Rows are the union of the registry and whatever the files hold, so a key
    // nobody declared shows up as a visible row instead of an exception thrown
    // somewhere else.
    const present = new Set(
      environments.flatMap((environment) =>
        Object.keys(inventories[environment]?.[scope]?.keys ?? {}),
      ),
    );
    const keys = [
      ...declared,
      ...Array.from(present).filter((key) => !declared.includes(key)),
    ];

    const rows = keys.map((key) => {
      const isDeclared = declared.includes(key);
      const schema = schemaFor(ctx, scope, key, declarations);
      const cells = {};
      let presentSomewhere = false;

      for (const environment of environments) {
        const entry = inventories[environment]?.[scope]?.keys?.[key] ?? null;
        cells[environment] = {
          present: Boolean(entry),
          encrypted: entry ? entry.encrypted : null,
          fingerprint: fingerprints[environment]?.[scope]?.[key] ?? null,
        };

        if (!entry) {
          if (isDeclared) totals.unset += 1;
          continue;
        }

        presentSomewhere = true;
        if (isDeclared) totals.set += 1;
        else totals.undeclared += 1;

        if (!entry.encrypted) {
          findings.push({
            code: 'not-encrypted',
            severity: 'error',
            scope,
            key,
            environment,
            message:
              `${scope}.${key} in ${environment} is not ENC[…]. A plaintext ` +
              'value under a sops metadata block is the accident `sops-env check` ' +
              'exists to catch.',
          });
        }

        if (!isDeclared) {
          findings.push({
            code: 'undeclared',
            severity: 'error',
            scope,
            key,
            environment,
            message:
              `${scope}.${key} in ${environment} is not declared in ` +
              'secrets.config.mjs. `sops-env sync` refuses the whole ' +
              'projection until it is.',
          });
        }
      }

      if (isDeclared && schema?.presence === 'required') {
        for (const environment of scopeEnvironments) {
          if (cells[environment].present) continue;
          findings.push({
            code: 'missing-required',
            severity: 'error',
            scope,
            key,
            environment,
            message:
              `${scope}.${key} is required by the ${schema.app} schema — no ` +
              `default, not optional — and is missing from ${environment}. The ` +
              'app cannot boot without it unless the platform supplies it ' +
              'directly, which this tool cannot see.',
          });
        }
      }

      // Only for a key the schema does not require. A required key missing
      // everywhere already produced one error per environment above, and saying
      // "it is also nowhere" adds nothing but sends the reader looking for a
      // second cause — the same reason `checkPairs` reports a missing side as
      // unknown rather than as a mismatch.
      if (
        isDeclared &&
        !presentSomewhere &&
        !exemptions[key] &&
        schema?.presence !== 'required'
      ) {
        findings.push({
          code: 'missing-everywhere',
          severity: 'warn',
          scope,
          key,
          message:
            `${scope}.${key} is declared but set in no environment. Either it ` +
            'is not in use yet, or the registry is ahead of the store.',
        });
      }

      return {
        scope,
        key,
        declared: isDeclared,
        note: ctx.notes[scope]?.[key] ?? null,
        schema,
        cells,
      };
    });

    return { scope, receivingApps: receivingApps(ctx, scope), rows };
  });

  return {
    environments,
    scopes,
    rows: scopes.flatMap((group) => group.rows),
    totals,
    findings,
    counts: countBySeverity(findings),
  };
}
