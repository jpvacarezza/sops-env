import { APP_SCOPES, APPS, SCOPES, SCOPE_KEYS } from '../scopes.mjs';

/**
 * Validate a decrypted secrets document against the scope registry.
 *
 * Throws rather than warns: every caller either boots an app or writes to a
 * deployment platform, and both are worse places to discover that a key was
 * filed under the wrong audience.
 */
export function assertValidDocument(doc, { registry = SCOPE_KEYS } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Secrets document must be a mapping of scope → variables.');
  }

  const problems = [];

  for (const [scope, entries] of Object.entries(doc)) {
    if (!SCOPES.includes(scope)) {
      problems.push(
        `unknown scope "${scope}" (expected one of ${SCOPES.join(', ')})`,
      );
      continue;
    }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      problems.push(`scope "${scope}" must be a mapping of KEY: "value"`);
      continue;
    }

    const allowed = new Set(registry[scope] ?? []);
    for (const [key, value] of Object.entries(entries)) {
      if (!allowed.has(key)) {
        problems.push(
          `"${key}" is not declared for scope "${scope}" in tools/secrets/scopes.mjs`,
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

  const sharedKeys = new Set(registry.shared ?? []);
  for (const app of APPS) {
    for (const key of registry[app] ?? []) {
      if (sharedKeys.has(key)) {
        problems.push(
          `"${key}" is declared in both "shared" and "${app}"; those scopes merge, ` +
            'so keep it in exactly one',
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
export function projectEnv(doc, app, { registry = SCOPE_KEYS } = {}) {
  const scopes = APP_SCOPES[app];
  if (!scopes) {
    throw new Error(
      `Unknown app "${app}" (expected one of ${APPS.join(', ')}).`,
    );
  }

  assertValidDocument(doc, { registry });

  const env = {};
  for (const scope of scopes) {
    Object.assign(env, doc[scope] ?? {});
  }
  return env;
}
