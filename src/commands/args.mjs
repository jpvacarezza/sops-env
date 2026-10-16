/** Validate `<environment> <app>`, the prefix every secrets CLI shares. */
export function parseTarget(ctx, argv, usage) {
  const [environment, app] = argv;

  if (!ctx.environments.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${ctx.environments.join(', ')}.\n${usage}`,
    );
  }
  if (!ctx.apps.includes(app)) {
    throw new Error(
      `Unknown app "${app}". Expected one of: ${ctx.apps.join(', ')}.\n${usage}`,
    );
  }

  return { environment, app };
}

const RUN_USAGE =
  'usage: sops-env run <environment> <app> -- <command...>\n' +
  '   eg: sops-env run local api -- pnpm dev';

/**
 * `<environment> <app> -- <command...>`.
 *
 * The `--` is required rather than inferred: without it, `sops-env run
 * local api nx serve api` would have to guess where the command starts, and
 * guessing wrong runs the wrong process with real secrets in its environment.
 */
export function parseRunArgs(ctx, argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) {
    throw new Error(`Missing \`--\` before the command.\n${RUN_USAGE}`);
  }

  const { environment, app } = parseTarget(
    ctx,
    argv.slice(0, separator),
    RUN_USAGE,
  );
  const command = argv.slice(separator + 1);

  if (command.length === 0) {
    throw new Error(`No command given after \`--\`.\n${RUN_USAGE}`);
  }

  return { environment, app, command };
}
