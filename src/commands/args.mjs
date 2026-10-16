import { APPS, ENVIRONMENTS } from '../scopes.mjs';

/** Validate `<environment> <app>`, the prefix every secrets CLI shares. */
export function parseTarget(argv, usage) {
  const [environment, app] = argv;

  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${ENVIRONMENTS.join(', ')}.\n${usage}`,
    );
  }
  if (!APPS.includes(app)) {
    throw new Error(
      `Unknown app "${app}". Expected one of: ${APPS.join(', ')}.\n${usage}`,
    );
  }

  return { environment, app };
}

const RUN_USAGE =
  'usage: pnpm secrets:run <environment> <app> -- <command...>\n' +
  '   eg: pnpm secrets:run local api -- pnpm nx serve api';

/**
 * `<environment> <app> -- <command...>`.
 *
 * The `--` is required rather than inferred: without it, `pnpm secrets:run
 * local api nx serve api` would have to guess where the command starts, and
 * guessing wrong runs the wrong process with real secrets in its environment.
 */
export function parseRunArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) {
    throw new Error(`Missing \`--\` before the command.\n${RUN_USAGE}`);
  }

  const { environment, app } = parseTarget(argv.slice(0, separator), RUN_USAGE);
  const command = argv.slice(separator + 1);

  if (command.length === 0) {
    throw new Error(`No command given after \`--\`.\n${RUN_USAGE}`);
  }

  return { environment, app, command };
}
