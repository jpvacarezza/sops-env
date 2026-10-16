/**
 * Validate a decrypted secrets document against the scope registry.
 *
 * Throws rather than warns: every caller either boots an app or writes to a
 * deployment platform, and both are worse places to discover that a key was
 * filed under the wrong audience.
 */
export function assertValidDocument(ctx, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Secrets document must be a mapping of scope → variables.');
  }

  const problems = [];

  for (const [scope, entries] of Object.entries(doc)) {
    if (!ctx.scopes.includes(scope)) {
      problems.push(
        `unknown scope "${scope}" (expected one of ${ctx.scopes.join(', ')})`,
      );
      continue;
    }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      problems.push(`scope "${scope}" must be a mapping of KEY: "value"`);
      continue;
    }

    const allowed = new Set(ctx.registry[scope] ?? []);
    for (const [key, value] of Object.entries(entries)) {
      if (!allowed.has(key)) {
        problems.push(
          `"${key}" is not declared for scope "${scope}" in secrets.config.mjs`,
        );
        continue;
      }
      if (typeof value !== 'string') {
        problems.push(
          `"${key}" in scope "${scope}" is ${typeof value}, not a string — ` +
            'quote it in YAML ("true", "1"), because environment variables are text',
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid secrets document:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/**
 * Flatten the scopes an app receives into the environment it will be given.
 *
 * A missing scope is not an error: `local.enc.yaml` legitimately omits keys
 * that only production sets, and every app's Zod schema is what decides
 * whether the result is complete.
 */
export function projectEnv(ctx, doc, app) {
  const scopes = ctx.appScopes[app];
  if (!scopes) {
    throw new Error(
      `Unknown app "${app}" (expected one of ${ctx.apps.join(', ')}).`,
    );
  }

  assertValidDocument(ctx, doc);

  const env = {};
  for (const scope of scopes) {
    Object.assign(env, doc[scope] ?? {});
  }
  return env;
}
