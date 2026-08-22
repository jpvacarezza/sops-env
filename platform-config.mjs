/**
 * Resolve platform credentials and destination IDs from the process environment.
 *
 * Kept separate from the providers so unit tests never need real tokens, and so
 * a missing variable fails with a name rather than a 401 from the platform.
 */

const VERCEL_TARGETS = {
  // Staging rides Vercel's preview target until a custom "staging" environment
  // id is configured. Override with VERCEL_SYNC_TARGETS_STAGING=preview,production
  // (comma-separated) if the project layout differs.
  staging: () =>
    (process.env.VERCEL_SYNC_TARGETS_STAGING || 'preview')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  production: () =>
    (process.env.VERCEL_SYNC_TARGETS_PRODUCTION || 'production')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
};

export function resolveVercelConfig(app, environment, env = process.env) {
  const token = required(env, 'VERCEL_TOKEN');
  const teamId = env.VERCEL_ORG_ID || undefined;
  const projectId = required(
    env,
    app === 'web' ? 'VERCEL_PROJECT_ID_WEB' : 'VERCEL_PROJECT_ID_ADMIN',
  );
  const targets = VERCEL_TARGETS[environment]?.() ?? [environment];
  if (targets.length === 0) {
    throw new Error(
      `No Vercel targets configured for environment "${environment}".`,
    );
  }
  return { token, teamId, projectId, targets };
}

/**
 * Both ids are per environment, because the service is too: this project holds
 * `api.staging` and `api.production` as distinct services rather than one
 * service spanning both environments. An environment-independent
 * `RAILWAY_SERVICE_ID_API` therefore let a `sync production` run reuse the
 * staging service id and exit 0 having written production values to staging —
 * the suffix makes that a named missing variable instead.
 */
export function resolveRailwayConfig(environment, env = process.env) {
  const suffix = environment === 'production' ? 'PRODUCTION' : 'STAGING';
  const token = required(env, 'RAILWAY_TOKEN');
  const projectId = required(env, 'RAILWAY_PROJECT_ID');
  const serviceId = required(env, `RAILWAY_SERVICE_ID_API_${suffix}`);
  const environmentId = required(env, `RAILWAY_ENVIRONMENT_ID_${suffix}`);
  return { token, projectId, serviceId, environmentId };
}

function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment (or a GitHub Actions secret) before syncing.`,
    );
  }
  return value;
}
