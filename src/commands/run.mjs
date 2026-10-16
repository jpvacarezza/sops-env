import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { parseRunArgs } from './args.mjs';
import { projectEnv } from '../store/project.mjs';
import { secretsFilePath } from '../store/paths.mjs';

/**
 * Decrypt, project the scopes this app receives, and run a command with them.
 *
 * Nothing touches the disk: this is the path that avoids a plaintext
 * `.env.local` existing at all. `secrets:materialize` is the escape hatch for
 * tools that insist on a file.
 */
export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseRunArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const { environment, app, command } = parsed;

  let env;
  try {
    const doc = decryptSecretsFile(secretsFilePath(environment));
    env = projectEnv(doc, app);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  console.error(
    `secrets: injecting ${Object.keys(env).length} variables for ${app} (${environment})`,
  );

  // The projection wins over the ambient environment: a stale exported value
  // in the developer's shell must not quietly outrank the store.
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  if (result.error?.code === 'ENOENT') {
    console.error(`Command not found: ${command[0]}`);
    return 127;
  }

  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
