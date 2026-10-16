import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { appEnvFilePath, secretsFilePath } from '../store/paths.mjs';
import { decryptSecretsFile } from '../store/decrypt.mjs';
import { formatEnvFile } from '../store/envfile.mjs';
import { parseTarget } from './args.mjs';
import { projectEnv } from '../store/project.mjs';

const usage = (ctx) =>
  `usage: sops-env materialize <${ctx.environments.join('|')}> <${ctx.apps.join('|')}|all>\n` +
  '   eg: sops-env materialize local all';

/**
 * Write each app's dotenv file from the store.
 *
 * The escape hatch, not the main path: Next tooling and some editors want a
 * real file. The file is generated, gitignored and disposable — edit the
 * ciphertext and regenerate, never the other way round.
 */
export function main(ctx, argv) {
  const [environment, target] = argv;
  const apps = target === 'all' ? ctx.apps : [target];

  try {
    for (const app of apps) parseTarget(ctx, [environment, app], usage(ctx));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let doc;
  try {
    doc = decryptSecretsFile(secretsFilePath(ctx, environment));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  for (const app of apps) {
    const env = projectEnv(ctx, doc, app);
    const file = appEnvFilePath(ctx, app);
    mkdirSync(dirname(file), { recursive: true });
    // 0600: the one file in the tree that holds plaintext secrets.
    writeFileSync(file, formatEnvFile(env), { mode: 0o600 });
    console.log(
      `${ctx.relative(file)} — ${Object.keys(env).length} variables (${environment})`,
    );
  }

  return 0;
}
