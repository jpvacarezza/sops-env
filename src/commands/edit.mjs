import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { secretsFilePath, sopsConfigPath } from '../store/paths.mjs';

export function main(ctx, argv) {
  const [environment] = argv;
  const usage = `usage: sops-env edit <${ctx.environments.join('|')}>`;

  let file;
  try {
    file = secretsFilePath(ctx, environment);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 1;
  }

  if (!existsSync(sopsConfigPath(ctx))) {
    console.error(
      `No ${ctx.store.sopsConfig} at ${ctx.root}, so sops has no recipients to encrypt for.\n` +
        `Run \`sops-env init --${ctx.environments[0]} <age1...>\` first.`,
    );
    return 1;
  }

  // `sops` both creates and edits: on a missing file it opens an empty buffer
  // and encrypts on save using the matching creation rule. stdio is inherited
  // so $EDITOR gets a real terminal. cwd is the project root: sops finds the
  // creation rules by walking up from there.
  const result = spawnSync('sops', [file], { stdio: 'inherit', cwd: ctx.root });

  if (result.error?.code === 'ENOENT') {
    console.error(
      '`sops` was not found on PATH. Install it with `brew install sops` (macOS), ' +
        '`winget install SecretsOPerationS.SOPS --version 3.9.4 --source winget` ' +
        '(Windows — reopen the terminal afterwards, PATH changes do not reach open ' +
        'shells), or from https://github.com/getsops/sops/releases.',
    );
    return 1;
  }

  return result.status ?? 1;
}
