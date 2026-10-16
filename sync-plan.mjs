import { DEPLOYABLE_APPS, ENVIRONMENTS } from './scopes.mjs';
import { projectEnv } from './project.mjs';

const SYNCABLE = ENVIRONMENTS.filter((environment) => environment !== 'local');

const USAGE =
  'usage: pnpm secrets:sync <staging|production> [api|web|admin|all] [--dry-run]\n' +
  '   eg: pnpm secrets:sync staging --dry-run\n' +
  '       pnpm secrets:sync production web';

/**
 * `local` is laptop-only. Syncing it would push placeholder "change-me" values
 * into staging/production and overwrite real secrets — refuse rather than warn.
 */
export function parseSyncArgs(argv) {
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
  if (environment === 'local') {
    throw new Error(
      'Refusing to sync the "local" environment to any platform. ' +
        'Edit staging/production ciphertext and sync those.\n' +
        USAGE,
    );
  }
  if (!SYNCABLE.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Expected one of: ${SYNCABLE.join(', ')}.\n${USAGE}`,
    );
  }

  let apps;
  if (appArg === 'all') {
    apps = [...DEPLOYABLE_APPS];
  } else if (DEPLOYABLE_APPS.includes(appArg)) {
    apps = [appArg];
  } else {
    throw new Error(
      `Unknown app "${appArg}". Expected one of: ${DEPLOYABLE_APPS.join(', ')}, all.\n${USAGE}`,
    );
  }

  if (positional.length > 2) {
    throw new Error(`Unexpected argument "${positional[2]}".\n${USAGE}`);
  }

  return { environment, apps, dryRun: flags.has('--dry-run') };
}

/** Vercel: public client vars stay readable; everything else is sensitive. */
export function vercelVarType(key) {
  return key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'sensitive';
}

/**
 * Build the per-destination work list for one sync.
 *
 * Each row exposes key names for logging and a `getEnv()` that the applicator
 * alone calls — so a dry-run (or a mistaken `console.log(plan)`) cannot dump
 * secret values.
 */
/**
 * Where one app's projection is pushed. ADR-0018: api on Railway, the two fronts
 * on Vercel.
 *
 * Exported so anything that *shows* a destination reads it from the same place
 * the sync does. A second copy of this rule elsewhere would eventually disagree
 * with where the values actually go, which is the worst kind of wrong label.
 */
export function destinationFor(app) {
  return app === 'api' ? 'railway/api' : `vercel/${app}`;
}

export function planSync(doc, { environment, apps }) {
  return apps.map((app) => {
    const env = projectEnv(doc, app);
    const keys = Object.keys(env).sort();
    const destination = destinationFor(app);

    return {
      environment,
      app,
      destination,
      keys,
      getEnv: () => ({ ...env }),
    };
  });
}
