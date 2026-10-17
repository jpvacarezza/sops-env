import { relative as nodeRelative } from 'node:path';

import { BUILTIN_PROVIDERS } from '../providers/index.mjs';
import { APP_DEFAULTS, DEFAULTS } from './defaults.mjs';
import { validateConfig } from './validate.mjs';

/**
 * Freeze every plain object and array reachable from `value`. Functions, RegExps
 * and ES module namespaces are left alone: a namespace cannot be frozen (it throws),
 * and a provider module is code, not config. `ctx.providers` itself is frozen, so
 * the map cannot change; the modules inside it are not touched.
 */
export function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof RegExp ||
    value[Symbol.toStringTag] === 'Module'
  )
    return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Each provider's block over its default, and each map inside it (`targets`,
 * `environment`) over the default map, so `vercel: { token: 'MY_TOKEN' }` keeps
 * `targets.staging === ['preview']`.
 */
function mergeProviderConfig(overrides) {
  const names = new Set([
    ...Object.keys(DEFAULTS.providers),
    ...Object.keys(overrides),
  ]);
  return Object.fromEntries(
    [...names].map((name) => {
      const base = DEFAULTS.providers[name] ?? {};
      const override = overrides[name] ?? {};
      const merged = { ...base, ...override };
      for (const [field, value] of Object.entries(override)) {
        if (isObject(value) && isObject(base[field]))
          merged[field] = { ...base[field], ...value };
      }
      return [name, structuredClone(merged)];
    }),
  );
}

/**
 * Pure: raw config in, frozen `ctx` out. Throws one error listing every problem.
 *
 * `providers` is the module map (`{ name: Provider }`), the builtins by default.
 * `loadConfig` passes the builtins plus whatever the config imported by path.
 * An inline provider object in a destination is registered under its `name` and
 * the destination is rewritten to that name, so downstream code only ever sees a
 * string and one map.
 */
export function resolveConfig(
  raw,
  { root, configFile, providers = BUILTIN_PROVIDERS },
) {
  const registered = { ...providers };
  if (isObject(raw?.apps)) {
    for (const entry of Object.values(raw.apps)) {
      const provider = entry?.destination?.provider;
      if (isObject(provider) && typeof provider.name === 'string')
        registered[provider.name] = provider;
    }
  }

  const problems = validateConfig(raw, {
    providers: Object.keys(registered).length > 0 ? registered : null,
    root: typeof root === 'string' ? root : null,
  });
  if (problems.length > 0) {
    throw new Error(
      `Invalid secrets.config.mjs:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  const environmentsConfig = raw.environments ?? DEFAULTS.environments;
  const environments = Object.keys(environmentsConfig);
  const store = { ...DEFAULTS.store, ...(raw.store ?? {}) };
  const contract = { ...DEFAULTS.contract, ...(raw.contract ?? {}) };
  const exemptions = {
    undeclared: { ...(raw.exemptions?.undeclared ?? {}) },
    platformProvided: { ...(raw.exemptions?.platformProvided ?? {}) },
    derived: { ...(raw.exemptions?.derived ?? {}) },
  };

  const scopes = Object.keys(raw.scopes);
  const registry = Object.fromEntries(
    scopes.map((scope) => [scope, Object.keys(raw.scopes[scope].keys)]),
  );
  const notes = Object.fromEntries(
    scopes.map((scope) => [scope, { ...raw.scopes[scope].keys }]),
  );

  const apps = Object.keys(raw.apps);
  const app = Object.fromEntries(
    apps.map((name) => {
      const entry = raw.apps[name];
      const provider = entry.destination?.provider;
      // Clone minus `provider` (an inline one holds functions, which do not
      // structuredClone) so freezing never reaches the user's own objects.
      const { provider: _provider, ...rest } = entry.destination ?? {};
      const destination = entry.destination
        ? {
            ...structuredClone(rest),
            provider: isObject(provider) ? provider.name : provider,
          }
        : null;
      return [
        name,
        {
          scopes: [...entry.scopes],
          dotenv: entry.dotenv ?? APP_DEFAULTS.dotenv(name),
          example: entry.example ?? APP_DEFAULTS.example(name),
          schema: entry.schema
            ? {
                keys: entry.schema.keys ?? null,
                command: entry.schema.command
                  ? [...entry.schema.command]
                  : null,
                cwd: entry.schema.cwd ?? APP_DEFAULTS.schemaCwd,
              }
            : null,
          destination,
        },
      ];
    }),
  );

  const ctx = {
    environments,
    syncable: environments.filter((name) => environmentsConfig[name].sync),
    nodeEnv: Object.fromEntries(
      environments.map((name) => [name, environmentsConfig[name].nodeEnv]),
    ),
    scopes,
    registry,
    notes,
    apps,
    appScopes: Object.fromEntries(
      apps.map((name) => [name, [...app[name].scopes]]),
    ),
    deployableApps: apps.filter((name) => app[name].destination !== null),
    app,
    exemptions,
    notDriftWhenUnset: {
      ...exemptions.undeclared,
      ...exemptions.derived,
      ...exemptions.platformProvided,
    },
    pairs: (raw.pairs ?? DEFAULTS.pairs).map((pair) => ({
      ...pair,
      left: { ...pair.left },
      right: { ...pair.right },
    })),
    publicPrefixes: [...(raw.publicPrefixes ?? DEFAULTS.publicPrefixes)],
    placeholderPattern: raw.placeholderPattern ?? DEFAULTS.placeholderPattern,
    store: { ...store, tracked: [...store.tracked] },
    contract: {
      sourceRoots: [...contract.sourceRoots],
      extraFiles: [...contract.extraFiles],
      ignore: [...contract.ignore],
    },
    providerConfig: mergeProviderConfig(raw.providers ?? {}),
    providers: registered,
    root,
    configFile,
    relative: (absolute) => nodeRelative(root, absolute).split('\\').join('/'),
  };

  return deepFreeze(ctx);
}
