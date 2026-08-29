/**
 * Does the generated `.env.local` on this machine still match the store?
 *
 * `materialize.mjs` is the only thing that touches `apps/<app>/.env.local`, and
 * it only ever writes. Nothing reads one back, so a variable added to the store
 * after a file was generated is invisible to every check there is:
 * `env-contract.spec.mjs` compares names across the registry, the schemas and
 * the `.env.example`s; `secrets:list` adds presence per environment. All of
 * those are questions about the store, and none of them is a question about
 * this disk.
 *
 * That gap has a cost on the record. `BETTER_AUTH_URL_ADMIN` — required, no
 * default — landed in the store on one day; an `apps/api/.env.local` generated
 * nine days earlier did not have it. `parseApiEnv` throws at import, so the API
 * never bound its port, the BFF proxy's fetch was refused, and the browser was
 * handed "Authentication service unavailable" by a route in another app that
 * knows nothing about environment variables. `secrets:list` reported zero
 * errors throughout, correctly: the store was fine.
 *
 * Reads key names only — never a value, and never the age key. SOPS leaves
 * mapping keys in plaintext, the same property `inventory.mjs` documents and
 * relies on, so this runs in CI and on a machine with no key just as well.
 */
import { existsSync, readFileSync } from 'node:fs';

import { readExampleKeys } from './env-contract.mjs';
import { appEnvFilePath } from './paths.mjs';
import { APP_SCOPES, APPS } from './scopes.mjs';

/**
 * Every key the store would project into one app, in scope-merge order.
 *
 * Reuses `APP_SCOPES` rather than reading the app's scope alone, because
 * `shared` merges into all three and a key typed there belongs on every disk.
 */
export function storeKeysForApp(
  app,
  inventory,
  { appScopes = APP_SCOPES } = {},
) {
  const keys = [];

  for (const scope of appScopes[app] ?? []) {
    for (const key of Object.keys(inventory?.[scope]?.keys ?? {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  return keys;
}

/**
 * Findings for one environment's materialized files.
 *
 * Only `local` has any: staging and production reach their platform through
 * `secrets:sync`, so no file is expected on disk and its absence is the normal
 * state rather than drift. Saying otherwise would put two permanent errors in
 * front of every reader until they learned to ignore the whole section.
 */
export function materializedFindings({
  environment,
  inventory,
  declarations = {},
  apps = APPS,
  exists = existsSync,
  readFile = readFileSync,
  envFilePath = appEnvFilePath,
}) {
  if (environment !== 'local') return [];

  const findings = [];

  for (const app of apps) {
    const expected = storeKeysForApp(app, inventory);
    if (expected.length === 0) continue;

    const file = envFilePath(app);
    const relative = `apps/${app}/.env.local`;

    if (!exists(file)) {
      findings.push({
        code: 'not-materialized',
        severity: 'error',
        scope: app,
        key: null,
        environment,
        message:
          `${relative} does not exist and the store declares ${expected.length} ` +
          `variable(s) for ${app}. Run \`pnpm secrets:materialize local ${app}\`.`,
      });
      continue;
    }

    const onDisk = new Set(readExampleKeys(readFile(file, 'utf8')));

    for (const key of expected) {
      if (onDisk.has(key)) continue;

      // Requiredness decides severity because it decides the symptom. A missing
      // required key is a process that will not start; a missing optional one is
      // a feature quietly switched off, which is worth saying and is not an
      // emergency.
      const required = declarations[app]?.[key]?.presence === 'required';

      findings.push({
        code: required ? 'stale-materialized' : 'drifted-materialized',
        severity: required ? 'error' : 'warn',
        scope: app,
        key,
        environment,
        message: required
          ? `${app}.${key} is in the store and missing from ${relative}, and the ` +
            `${app} schema requires it — the app will not boot. The file is ` +
            'generated and predates the variable: `pnpm secrets:materialize ' +
            `local ${app}\`.`
          : `${app}.${key} is in the store and missing from ${relative}. The ` +
            'file is generated and predates the variable: `pnpm ' +
            `secrets:materialize local ${app}\`.`,
      });
    }

    for (const key of onDisk) {
      if (expected.includes(key)) continue;

      // The other direction, and the one README names: "a hand-maintained
      // `.env.local` is how a machine silently keeps a variable the registry has
      // already dropped." Only regenerating removes it, so a stale key can keep
      // a retired code path alive on one laptop and nowhere else.
      findings.push({
        code: 'orphaned-materialized',
        severity: 'warn',
        scope: app,
        key,
        environment,
        message:
          `${app}.${key} is in ${relative} and the store no longer declares it. ` +
          'Either it was hand-edited or the registry dropped it after the file ' +
          `was generated: \`pnpm secrets:materialize local ${app}\`.`,
      });
    }
  }

  return findings;
}
