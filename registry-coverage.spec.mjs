import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_ROOT } from './paths.mjs';
import { APPS, APP_SCOPES, SCOPE_KEYS } from './scopes.mjs';

/**
 * `.env.example` is the documented contract for each app (technical-spec §18),
 * and the registry is what decides whether a variable can be projected at all.
 * If they drift, `secrets:sync` silently stops shipping a variable the app
 * documents as required — so this test reads the examples rather than trusting
 * that both files were updated in the same PR.
 *
 * Only assignments are read; comments (including the deliberately commented
 * `VENDOR_DATA_DIR` and the removed vendor keys) are not part of the contract.
 */
function documentedKeys(app) {
  const text = readFileSync(
    join(WORKSPACE_ROOT, 'apps', app, '.env.example'),
    'utf8',
  );

  return text
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter(Boolean);
}

describe('scope registry covers every documented variable', () => {
  for (const app of APPS) {
    it(`${app}: .env.example declares nothing the projection would drop`, () => {
      const projected = new Set(
        APP_SCOPES[app].flatMap((scope) => SCOPE_KEYS[scope]),
      );
      const missing = documentedKeys(app).filter((key) => !projected.has(key));

      expect(missing, `add these to tools/secrets/scopes.mjs`).toEqual([]);
    });
  }
});
