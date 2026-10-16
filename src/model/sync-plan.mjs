import { projectEnv } from '../store/project.mjs';

const USAGE =
  'usage: sops-env sync <environment> [<app>|all] [--dry-run]\n' +
  '   eg: sops-env sync staging --dry-run\n' +
  '       sops-env sync production web';

/**
 * An environment marked `sync: false` is laptop-only (`local` by default).
 * Syncing it would push placeholder values into staging/production and
 * overwrite real secrets — refuse rather than warn.
 */
export function parseSyncArgs(ctx, argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = [...flags].filter((flag) => flag !== '--dry-run');
  if (unknown.length > 0) {
    throw new Error(`Unknown flag ${unknown[0]}.\n${USAGE}`);
  }

  const [environment, appArg = 'all'] = positional;
  if (!environment) {
    throw new Error(`Missing environment.\n${USAGE}`);
  }
  if (
    ctx.environments.includes(environment) &&
    !ctx.syncable.includes(environment)
  ) {
    throw new Error(
      `Refusing to sync "${environment}" to any platform: it is marked sync: false in secrets.config.mjs.\n` +
        USAGE,
    );
  }
  if (!ctx.syncable.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${ctx.syncable.join(', ')}.\n${USAGE}`,
    );
  }

  let apps;
  if (appArg === 'all') {
    apps = [...ctx.deployableApps];
  } else if (ctx.deployableApps.includes(appArg)) {
    apps = [appArg];
  } else {
    throw new Error(
      `Unknown app "${appArg}". Expected one of: ${ctx.deployableApps.join(', ')}, all.\n${USAGE}`,
    );
  }

  if (positional.length > 2) {
    throw new Error(`Unexpected argument "${positional[2]}".\n${USAGE}`);
  }

  return { environment, apps, dryRun: flags.has('--dry-run') };
}

/** Vercel: a public client var stays readable; everything else is sensitive. */
export function vercelVarType(ctx, key) {
  return ctx.publicPrefixes.some((prefix) => key.startsWith(prefix))
    ? 'plain'
    : 'sensitive';
}

/**
 * Where one app's projection is pushed: `railway/api`, `vercel/web`; null for
 * an app with no destination. Task 7 asks the provider instead.
 *
 * Exported so anything that *shows* a destination reads it from the same place
 * the sync does. A second copy of this rule elsewhere would eventually disagree
 * with where the values actually go, which is the worst kind of wrong label.
 */
export function destinationFor(ctx, app) {
  const destination = ctx.app[app]?.destination;
  return destination ? `${destination.provider}/${app}` : null;
}

/**
 * Build the per-destination work list for one sync.
 *
 * Each row exposes key names for logging and a `getEnv()` that the applicator
 * alone calls — so a dry-run (or a mistaken `console.log(plan)`) cannot dump
 * secret values.
 */
export function planSync(ctx, doc, { environment, apps }) {
  return apps.map((app) => {
    const env = projectEnv(ctx, doc, app);
    const keys = Object.keys(env).sort();
    return {
      environment,
      app,
      destination: destinationFor(ctx, app),
      keys,
      getEnv: () => ({ ...env }),
    };
  });
}
