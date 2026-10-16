import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfig } from './resolve.mjs';

export const CONFIG_FILE_NAME = 'secrets.config.mjs';

/** Identity, for editor completion through `types.d.ts`. */
export function defineConfig(config) {
  return config;
}

/** Nearest `secrets.config.mjs` at or above `cwd`, or null. */
export function findConfigFile(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Import the config module. Consumer-supplied providers given as a path string are
 * imported relative to the config file here, because importing is async and
 * `resolveConfig` is pure. `providers` starts as the builtin map (Task 7 wires it;
 * until then it is whatever the caller passes).
 */
export async function loadConfig({
  cwd = process.cwd(),
  file = process.env.SOPS_ENV_CONFIG,
  providers = {},
} = {}) {
  const configFile = file
    ? isAbsolute(file)
      ? file
      : resolve(cwd, file)
    : findConfigFile(cwd);

  if (!configFile) {
    throw new Error(
      `No ${CONFIG_FILE_NAME} found walking up from ${resolve(cwd)}. ` +
        `Create one at the repository root (see the sops-env README). Set SOPS_ENV_CONFIG to its path to keep it elsewhere.`,
    );
  }
  if (!existsSync(configFile)) {
    throw new Error(`${configFile} does not exist.`);
  }

  const loaded = await import(pathToFileURL(configFile).href);
  if (!('default' in loaded)) {
    throw new Error(
      `${configFile} has no default export. Export the config object as default.`,
    );
  }

  const raw = loaded.default;
  const registered = { ...providers };
  for (const [app, entry] of Object.entries(raw?.apps ?? {})) {
    const provider = entry?.destination?.provider;
    if (typeof provider === 'string' && /^\.{1,2}\//.test(provider)) {
      const target = resolve(dirname(configFile), provider);
      const module = await import(pathToFileURL(target).href);
      if (
        typeof module.label !== 'function' ||
        typeof module.upsert !== 'function'
      ) {
        throw new Error(
          `apps.${app}.destination.provider: ${provider} does not export label() and upsert()`,
        );
      }
      registered[provider] = module;
    }
  }

  return resolveConfig(raw, {
    root: dirname(configFile),
    configFile,
    providers: registered,
  });
}
