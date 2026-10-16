/**
 * Field-by-field checks over the raw config. Every message names the field with a
 * JS path (`apps.web.scopes[1]`) so a reader lands on the line.
 *
 * The names-only guard is the one security check here: a note that looks like a
 * key, a ciphertext blob, or a `KEY=value` line is a pasted secret, and the config
 * file is committed. Refusing it at load time is what makes "the config holds
 * names only" a property rather than a convention.
 */
import { isAbsolute, relative, resolve } from 'node:path';

import { APP_DEFAULTS } from './defaults.mjs';

const NAME = /^[A-Z][A-Z0-9_]*$/;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;
const LOOKS_LIKE_A_VALUE = /^(age1|AGE-SECRET-KEY-|ENC\[)/;
const NOT_A_NAME = 'not an environment variable name (UPPER_SNAKE_CASE)';

/**
 * Which fields of a builtin provider's config hold env-var NAMES. A string there
 * that is not a name is never echoed: it may be the token itself.
 */
const BUILTIN_FIELDS = {
  vercel: { names: ['token', 'team'], nameMaps: [], arrayMaps: ['targets'] },
  railway: {
    names: ['token', 'project'],
    nameMaps: ['environment'],
    arrayMaps: [],
  },
};

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Problems with a provider module or inline object, each naming the field
 * under `label` (`providers.fly.resolve is not a function`).
 */
export function providerProblems(label, provider) {
  if (provider === null || typeof provider !== 'object')
    return [`${label} is not an object`];
  const problems = [];
  if (typeof provider.name !== 'string' || provider.name === '')
    problems.push(`${label}.name must be a string`);
  for (const field of ['label', 'resolve', 'upsert']) {
    if (typeof provider[field] !== 'function')
      problems.push(`${label}.${field} is not a function`);
  }
  return problems;
}

/** Strings under a consumer provider's field, or null when the shape is wrong. */
function providerFieldStrings(value) {
  if (typeof value === 'string') return [value];
  if (isStringArray(value)) return value;
  if (
    isObject(value) &&
    Object.values(value).every(
      (entry) => typeof entry === 'string' || isStringArray(entry),
    )
  )
    return Object.values(value).flat();
  return null;
}

/** `providers.<name>` blocks: names where names go, maps one level deep. */
function validateProviderConfig(raw, bad) {
  if (raw.providers === undefined) return;
  if (!isObject(raw.providers)) {
    bad('providers', 'must be an object of { provider: { field: … } }');
    return;
  }
  for (const [provider, config] of Object.entries(raw.providers)) {
    const at = `providers.${provider}`;
    if (!isObject(config)) {
      bad(at, 'must be an object');
      continue;
    }
    const builtin = BUILTIN_FIELDS[provider];
    if (!builtin) {
      // A consumer's own provider: shape only, plus the note guard on strings.
      for (const [field, value] of Object.entries(config)) {
        const strings = providerFieldStrings(value);
        if (strings === null)
          bad(
            `${at}.${field}`,
            'must be a string, an array of strings, or an object of those',
          );
        else if (strings.some((entry) => noteProblem(entry)))
          bad(`${at}.${field}`, 'looks like a key or a value, not a name');
      }
      continue;
    }
    for (const [field, value] of Object.entries(config)) {
      if (builtin.names.includes(field)) {
        if (typeof value !== 'string')
          bad(`${at}.${field}`, 'must be a string');
        else if (!NAME.test(value)) bad(`${at}.${field}`, NOT_A_NAME);
      } else if (builtin.nameMaps.includes(field)) {
        if (!isObject(value)) {
          bad(`${at}.${field}`, 'must be { environment: NAME }');
          continue;
        }
        for (const [environment, name] of Object.entries(value)) {
          if (typeof name !== 'string' || !NAME.test(name))
            bad(`${at}.${field}.${environment}`, NOT_A_NAME);
        }
      } else if (builtin.arrayMaps.includes(field)) {
        if (!isObject(value)) {
          bad(`${at}.${field}`, 'must be { environment: [string, …] }');
          continue;
        }
        for (const [environment, list] of Object.entries(value)) {
          if (!isStringArray(list))
            bad(`${at}.${field}.${environment}`, 'must be an array of strings');
        }
      } else {
        bad(`${at}.${field}`, `is not a ${provider} setting`);
      }
    }
  }
}

/** Destination `project` / `service.*` are env-var names; never echo them. */
function validateDestinationNames(app, destination, bad) {
  const at = `apps.${app}.destination`;
  if (
    destination.project !== undefined &&
    (typeof destination.project !== 'string' || !NAME.test(destination.project))
  )
    bad(`${at}.project`, NOT_A_NAME);
  if (destination.service === undefined) return;
  if (!isObject(destination.service)) {
    bad(`${at}.service`, 'must be { environment: NAME }');
    return;
  }
  for (const [environment, name] of Object.entries(destination.service)) {
    if (typeof name !== 'string' || !NAME.test(name))
      bad(`${at}.service.${environment}`, NOT_A_NAME);
  }
}

/** `store.dir` / `store.file`: one relative directory, one flat file name. */
function validateStore(raw, bad) {
  if (raw.store === undefined) return;
  if (!isObject(raw.store)) {
    bad('store', 'must be an object');
    return;
  }
  const { dir, file } = raw.store;
  if (dir !== undefined) {
    if (typeof dir !== 'string' || dir === '')
      bad('store.dir', 'must be a non-empty relative path');
    else if (isAbsolute(dir) || /^[/\\]/.test(dir))
      bad('store.dir', `${JSON.stringify(dir)} must be relative to the config`);
    else if (dir.split(/[/\\]/).includes('..'))
      bad('store.dir', `${JSON.stringify(dir)} must not contain ".."`);
  }
  if (file === undefined) return;
  const count =
    typeof file === 'string' ? file.split('<environment>').length - 1 : 0;
  if (count === 0)
    bad('store.file', `${JSON.stringify(file)} must contain <environment>`);
  else if (count > 1)
    bad(
      'store.file',
      `${JSON.stringify(file)} must contain exactly one <environment>`,
    );
  else if (/[/\\]/.test(file))
    bad(
      'store.file',
      `${JSON.stringify(file)} is a file name; a path separator is not allowed (use store.dir)`,
    );
  else if (file.includes('..'))
    bad('store.file', `${JSON.stringify(file)} must not contain ".."`);
}

export function noteProblem(note) {
  if (note === null) return null;
  if (typeof note !== 'string')
    return `must be a string or null, got ${typeof note}`;
  if (LOOKS_LIKE_A_VALUE.test(note))
    return 'looks like a key or a value, not a note';
  if (note.includes('='))
    return 'contains "=", which reads as KEY=value; notes are prose';
  return null;
}

export function validateConfig(raw, { providers = null, root = null } = {}) {
  const problems = [];
  const bad = (field, message) => problems.push(`${field}: ${message}`);

  if (!isObject(raw)) return ['config: the default export must be an object'];

  // scopes
  if (!isObject(raw.scopes) || Object.keys(raw.scopes).length === 0) {
    bad('scopes', 'declare at least one scope');
  } else {
    for (const [scope, entry] of Object.entries(raw.scopes)) {
      if (!isObject(entry) || !isObject(entry.keys)) {
        bad(`scopes.${scope}`, 'must be { keys: { KEY: string | null } }');
        continue;
      }
      for (const [key, note] of Object.entries(entry.keys)) {
        if (!NAME.test(key))
          bad(
            `scopes.${scope}.keys.${key}`,
            'not an environment variable name (UPPER_SNAKE_CASE)',
          );
        const problem = noteProblem(note);
        if (problem) bad(`scopes.${scope}.keys.${key}`, problem);
      }
    }
  }
  const scopes = isObject(raw.scopes) ? Object.keys(raw.scopes) : [];

  // apps
  if (!isObject(raw.apps) || Object.keys(raw.apps).length === 0) {
    bad('apps', 'declare at least one app');
  } else {
    for (const [app, entry] of Object.entries(raw.apps)) {
      if (!isObject(entry)) {
        bad(`apps.${app}`, 'must be an object');
        continue;
      }
      if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
        bad(`apps.${app}.scopes`, 'list the scopes this app receives');
      } else {
        entry.scopes.forEach((scope, index) => {
          if (!scopes.includes(scope))
            bad(
              `apps.${app}.scopes[${index}]`,
              `"${scope}" is not a declared scope`,
            );
        });
      }
      if (entry.schema !== undefined && entry.schema !== null) {
        if (!isObject(entry.schema))
          bad(`apps.${app}.schema`, 'must be null or { file, exportName }');
        else {
          if (typeof entry.schema.file !== 'string')
            bad(`apps.${app}.schema.file`, 'required');
          if (typeof entry.schema.exportName !== 'string')
            bad(`apps.${app}.schema.exportName`, 'required');
        }
      }
      if (entry.destination !== undefined && entry.destination !== null) {
        if (!isObject(entry.destination))
          bad(`apps.${app}.destination`, 'must be null or { provider, … }');
        else {
          const provider = entry.destination.provider;
          validateDestinationNames(app, entry.destination, bad);
          if (isObject(provider)) {
            if (typeof provider.name !== 'string')
              bad(
                `apps.${app}.destination.provider`,
                'an inline provider needs a name',
              );
            else
              for (const problem of providerProblems(
                `providers.${provider.name}`,
                provider,
              ))
                bad(`apps.${app}.destination.provider`, problem);
          } else if (typeof provider !== 'string' || provider === '') {
            bad(
              `apps.${app}.destination.provider`,
              'name a provider (string) or give one inline',
            );
          } else if (providers && !(provider in providers)) {
            bad(
              `apps.${app}.destination.provider`,
              `"${provider}" is not a known provider (known: ${Object.keys(providers).join(', ')})`,
            );
          }
        }
      }
      // `materialize` writes here; a path that leaves the root is refused
      // before any command can write it.
      if (root !== null) {
        const dotenv = entry.dotenv ?? APP_DEFAULTS.dotenv(app);
        if (typeof dotenv !== 'string' || dotenv === '')
          bad(`apps.${app}.dotenv`, 'must be a path relative to the config');
        else {
          const inside = relative(resolve(root), resolve(root, dotenv));
          if (
            inside === '' ||
            inside.split(/[/\\]/)[0] === '..' ||
            isAbsolute(inside)
          )
            bad(
              `apps.${app}.dotenv`,
              `resolves outside the config root (${JSON.stringify(dotenv)})`,
            );
        }
      }
    }
  }

  // shared ↔ app collisions: those scopes merge, so a key in both is positional.
  if (isObject(raw.scopes) && isObject(raw.apps)) {
    for (const [app, entry] of Object.entries(raw.apps)) {
      const appScopes = Array.isArray(entry?.scopes) ? entry.scopes : [];
      const merged = appScopes.filter((scope) => scopes.includes(scope));
      const seen = new Map();
      for (const scope of merged) {
        for (const key of Object.keys(raw.scopes[scope].keys ?? {})) {
          if (seen.has(key)) {
            bad(
              `apps.${app}`,
              `"${key}" is declared in both "${seen.get(key)}" and "${scope}"; those scopes merge, so keep it in exactly one`,
            );
          } else seen.set(key, scope);
        }
      }
    }
  }

  // environments
  if (raw.environments !== undefined) {
    if (
      !isObject(raw.environments) ||
      Object.keys(raw.environments).length === 0
    )
      bad('environments', 'declare at least one environment');
    else {
      for (const [name, entry] of Object.entries(raw.environments)) {
        // The name becomes part of a file name and of a sops path_regex.
        if (!ENVIRONMENT_NAME.test(name))
          bad(
            `environments.${name}`,
            `name must match ${ENVIRONMENT_NAME} (lowercase, digits, dashes)`,
          );
        if (
          !isObject(entry) ||
          typeof entry.nodeEnv !== 'string' ||
          typeof entry.sync !== 'boolean'
        ) {
          bad(
            `environments.${name}`,
            'must be { nodeEnv: string, sync: boolean }',
          );
        }
      }
    }
  }

  validateStore(raw, bad);
  validateProviderConfig(raw, bad);

  // pairs
  if (raw.pairs !== undefined) {
    if (!Array.isArray(raw.pairs)) bad('pairs', 'must be an array');
    else {
      raw.pairs.forEach((pair, index) => {
        for (const side of ['left', 'right']) {
          const ref = pair?.[side];
          if (
            !isObject(ref) ||
            !scopes.includes(ref.scope) ||
            !(ref.key in (raw.scopes[ref.scope]?.keys ?? {}))
          ) {
            bad(
              `pairs[${index}].${side}`,
              `${ref?.scope}.${ref?.key} is not a declared key`,
            );
          }
        }
        if (!['equal', 'differ'].includes(pair?.relation))
          bad(`pairs[${index}].relation`, 'must be "equal" or "differ"');
        if (typeof pair?.name !== 'string' || typeof pair?.why !== 'string')
          bad(`pairs[${index}]`, 'needs a name and a why');
        else
          for (const field of ['name', 'why']) {
            const problem = noteProblem(pair[field]);
            if (problem) bad(`pairs[${index}].${field}`, problem);
          }
      });
    }
  }

  // exemptions, publicPrefixes, placeholderPattern, schemaRunner, contract
  if (raw.exemptions !== undefined) {
    for (const group of ['unparsedBySchema', 'platformProvided', 'derived']) {
      const map = raw.exemptions?.[group];
      if (map === undefined) continue;
      if (!isObject(map)) bad(`exemptions.${group}`, 'must be { KEY: reason }');
      else
        for (const [key, reason] of Object.entries(map)) {
          if (typeof reason !== 'string' || reason.length === 0)
            bad(`exemptions.${group}.${key}`, 'give the reason as a string');
          else {
            const problem = noteProblem(reason);
            if (problem) bad(`exemptions.${group}.${key}`, problem);
          }
        }
    }
  }
  if (raw.publicPrefixes !== undefined && !Array.isArray(raw.publicPrefixes))
    bad('publicPrefixes', 'must be an array of strings');
  if (
    raw.placeholderPattern !== undefined &&
    !(raw.placeholderPattern instanceof RegExp)
  )
    bad('placeholderPattern', 'must be a RegExp');
  if (raw.schemaRunner !== undefined) {
    if (!isObject(raw.schemaRunner)) bad('schemaRunner', 'must be an object');
    else if (
      raw.schemaRunner.runner !== undefined &&
      !['tsx', 'node'].includes(raw.schemaRunner.runner)
    )
      bad('schemaRunner.runner', 'must be "tsx" or "node"');
  }
  if (raw.contract !== undefined && !isObject(raw.contract))
    bad('contract', 'must be an object');

  return problems;
}
