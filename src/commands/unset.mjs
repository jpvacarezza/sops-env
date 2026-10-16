/**
 * `sops-env unset` — remove one variable from one or more environments.
 *
 * A separate command rather than a `--unset` flag on `set`, because the two
 * read differently at a call site you are about to run against production,
 * and because this one takes no stdin: a flag would leave `set` with a mode
 * in which its whole stdin contract does not apply.
 */
import { main as run } from './set.mjs';

export function main(ctx, argv) {
  return run(ctx, argv, { mode: 'unset' });
}
