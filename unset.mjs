/**
 * `pnpm secrets:unset` — remove one variable from one or more environments.
 *
 * A separate entry point rather than a `--unset` flag on `secrets:set`, because
 * the two read differently at a call site you are about to run against
 * production, and because this one takes no stdin: a flag would leave `set` with
 * a mode in which its whole stdin contract does not apply.
 */
import { fileURLToPath } from 'node:url';

import { main as run } from './set.mjs';

export function main(argv = process.argv.slice(2)) {
  return run(argv, { mode: 'unset' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
