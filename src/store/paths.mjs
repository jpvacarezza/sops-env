import { join } from 'node:path';

/** `<root>/<store.dir>`. */
export function storeDir(ctx) {
  return join(ctx.root, ctx.store.dir);
}

/** Ciphertext file for one environment. Never accepts an arbitrary path. */
export function secretsFilePath(ctx, environment) {
  if (!ctx.environments.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${ctx.environments.join(', ')}.`,
    );
  }
  return join(
    storeDir(ctx),
    ctx.store.file.replace('<environment>', environment),
  );
}

/** Where `materialize` writes a generated dotenv file. */
export function appEnvFilePath(ctx, app) {
  const entry = ctx.app[app];
  if (!entry) {
    throw new Error(
      `Unknown app "${app}". Expected one of: ${ctx.apps.join(', ')}.`,
    );
  }
  return join(ctx.root, entry.dotenv);
}

/** The sops creation-rules file. */
export function sopsConfigPath(ctx) {
  return join(ctx.root, ctx.store.sopsConfig);
}
