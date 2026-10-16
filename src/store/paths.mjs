import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENVIRONMENTS } from '../scopes.mjs';

/** Repository root, resolved from this file rather than the caller's CWD. */
export const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Ciphertext file for one environment. Never accepts an arbitrary path. */
export function secretsFilePath(environment, { root = WORKSPACE_ROOT } = {}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${ENVIRONMENTS.join(', ')}.`,
    );
  }
  return join(root, 'secrets', `${environment}.enc.yaml`);
}

/** Where `secrets:materialize` writes a generated dotenv file. */
export function appEnvFilePath(app, { root = WORKSPACE_ROOT } = {}) {
  return join(root, 'apps', app, '.env.local');
}
