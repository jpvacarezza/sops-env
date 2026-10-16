import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../src/config/resolve.mjs';
import { BUILTIN_PROVIDERS } from '../../src/providers/index.mjs';
import config from '../fixtures/project/secrets.config.mjs';

export const FIXTURE_ROOT = fileURLToPath(
  new URL('../fixtures/project', import.meta.url),
);
export const FIXTURE_CONFIG_FILE = join(FIXTURE_ROOT, 'secrets.config.mjs');
export const FIXTURE_AGE_KEY_FILE = fileURLToPath(
  new URL('../fixtures/age-key.txt', import.meta.url),
);

/** The fixture project's ctx, with top-level overrides (`fixtureCtx({ pairs: [] })`). */
export function fixtureCtx(overrides = {}) {
  return resolveConfig(
    { ...config, ...overrides },
    {
      root: FIXTURE_ROOT,
      configFile: FIXTURE_CONFIG_FILE,
      providers: BUILTIN_PROVIDERS,
    },
  );
}

/**
 * A ctx from a bare `{ scope: [KEY, …] }` registry, which is how the imported
 * specs describe their worlds. Every scope but `shared` becomes an app receiving
 * `['shared', scope]` (when `shared` exists), deployable unless listed in
 * `nonDeployable`; `api` goes to railway, everything else to vercel.
 */
export function registryCtx(
  registry,
  {
    environments = ['local', 'staging', 'production'],
    nonDeployable = [],
    root = '/repo',
    extra = {},
  } = {},
) {
  const scopes = Object.fromEntries(
    Object.entries(registry).map(([scope, keys]) => [
      scope,
      { keys: Object.fromEntries(keys.map((key) => [key, null])) },
    ]),
  );
  const apps = Object.fromEntries(
    Object.keys(registry)
      .filter((scope) => scope !== 'shared')
      .map((app) => [
        app,
        {
          scopes: 'shared' in registry ? ['shared', app] : [app],
          destination: nonDeployable.includes(app)
            ? null
            : app === 'api'
              ? {
                  provider: 'railway',
                  service: {
                    staging: 'RAILWAY_SERVICE_ID_API_STAGING',
                    production: 'RAILWAY_SERVICE_ID_API_PRODUCTION',
                  },
                }
              : {
                  provider: 'vercel',
                  project: `VERCEL_PROJECT_ID_${app.toUpperCase()}`,
                },
        },
      ]),
  );
  const environmentsConfig = Object.fromEntries(
    environments.map((name) => [
      name,
      {
        nodeEnv: name === 'local' ? 'development' : name,
        sync: name !== 'local',
      },
    ]),
  );

  // `extra` is spread into the raw config: `{ extra: { pairs: [...] } }`.
  return resolveConfig(
    { scopes, apps, environments: environmentsConfig, ...extra },
    {
      root,
      configFile: `${root}/secrets.config.mjs`,
      providers: BUILTIN_PROVIDERS,
    },
  );
}

/** The environment a sops spawn needs to decrypt the fixture. */
export function withFixtureKey(env = process.env) {
  return { ...env, SOPS_AGE_KEY_FILE: FIXTURE_AGE_KEY_FILE };
}
