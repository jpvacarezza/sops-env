// Runs the local CLI against test/fixtures/project: `pnpm try <command> [args]`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/sops-env.mjs', import.meta.url));
const fixtures = new URL('../test/fixtures/', import.meta.url);

const { status } = spawnSync(
  process.execPath,
  [bin, ...(process.argv.length > 2 ? process.argv.slice(2) : ['list'])],
  {
    cwd: fileURLToPath(new URL('project/', fixtures)),
    env: {
      ...process.env,
      SOPS_AGE_KEY_FILE: fileURLToPath(new URL('age-key.txt', fixtures)),
    },
    stdio: 'inherit',
  },
);
process.exit(status ?? 1);
