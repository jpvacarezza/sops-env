/**
 * Field-by-field checks over the raw config. Every message names the field with a
 * JS path (`apps.web.scopes[1]`) so a reader lands on the line.
 *
 * The names-only guard is the one security check here: a note that looks like a
 * key, a ciphertext blob, or a `KEY=value` line is a pasted secret, and the config
 * file is committed. Refusing it at load time is what makes "the config holds
 * names only" a property rather than a convention.
 */
const NAME = /^[A-Z][A-Z0-9_]*$/;
const LOOKS_LIKE_A_VALUE = /^(age1|AGE-SECRET-KEY-|ENC\[)/;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function validateConfig(raw, { providers = null } = {}) {
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
          if (isObject(provider)) {
            if (typeof provider.name !== 'string')
              bad(
                `apps.${app}.destination.provider`,
                'an inline provider needs a name',
              );
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

  // store
  if (raw.store !== undefined) {
    if (!isObject(raw.store)) bad('store', 'must be an object');
    else if (
      raw.store.file !== undefined &&
      (typeof raw.store.file !== 'string' ||
        !raw.store.file.includes('<environment>'))
    ) {
      bad(
        'store.file',
        `${JSON.stringify(raw.store.file)} must contain <environment>`,
      );
    }
  }

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
