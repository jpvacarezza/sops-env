import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPS, ENVIRONMENTS } from '../scopes.mjs';
import { WORKSPACE_ROOT, appEnvFilePath, secretsFilePath } from '../store/paths.mjs';
import { decryptSecretsFile } from '../store/decrypt.mjs';
import { formatEnvFile } from '../store/envfile.mjs';
import { parseTarget } from './args.mjs';
import { projectEnv } from '../store/project.mjs';

const USAGE =
  `usage: pnpm secrets:materialize <${ENVIRONMENTS.join('|')}> <${APPS.join('|')}|all>\n` +
  '   eg: pnpm secrets:materialize local all';

/**
 * Write `apps/<app>/.env.local` from the store.
 *
 * The escape hatch, not the main path: Next tooling and some editors want a
 * real file. The file is generated, gitignored and disposable — edit the
 * ciphertext and regenerate, never the other way round.
 */
export function main(argv = process.argv.slice(2)) {
  const [environment, target] = argv;
  const apps = target === 'all' ? APPS : [target];

  try {
    for (const app of apps) parseTarget([environment, app], USAGE);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let doc;
  try {
    doc = decryptSecretsFile(secretsFilePath(environment));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  for (const app of apps) {
    const env = projectEnv(doc, app);
    const file = appEnvFilePath(app);
    // 0600: the one file in the tree that holds plaintext secrets.
    writeFileSync(file, formatEnvFile(env), { mode: 0o600 });
    console.log(
      `${relative(WORKSPACE_ROOT, file)} — ${Object.keys(env).length} variables (${environment})`,
    );
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
