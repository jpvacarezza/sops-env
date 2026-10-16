import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACE_ROOT, secretsFilePath } from '../store/paths.mjs';
import { ENVIRONMENTS } from '../scopes.mjs';

const USAGE = `usage: pnpm secrets:edit <${ENVIRONMENTS.join('|')}>`;

export function main(argv = process.argv.slice(2)) {
  const [environment] = argv;

  let file;
  try {
    file = secretsFilePath(environment);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }

  if (!existsSync(join(WORKSPACE_ROOT, '.sops.yaml'))) {
    console.error(
      'No .sops.yaml at the repository root, so sops has no recipients to encrypt for.\n' +
        'Run `pnpm secrets:init --local <age1...>` first (see secrets/README.md).',
    );
    return 1;
  }

  // `sops` both creates and edits: on a missing file it opens an empty buffer
  // and encrypts on save using the matching creation rule. stdio is inherited
  // so $EDITOR gets a real terminal.
  const result = spawnSync('sops', [file], { stdio: 'inherit' });

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
