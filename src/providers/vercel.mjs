/**
 * Vercel: `/v10/projects/:id/env?upsert=true`, so a second sync updates values
 * instead of failing with ENV_CONFLICT. Values never appear in the summary.
 */
export const name = 'vercel';

export const label = (_ctx, { app }) => `vercel/${app}`;

/** A public client var stays readable; everything else is sensitive. */
export function varType(ctx, key) {
  return ctx.publicPrefixes.some((prefix) => key.startsWith(prefix))
    ? 'plain'
    : 'sensitive';
}

export function resolve(ctx, { app, environment, env }) {
  const names = ctx.providerConfig.vercel;
  const destination = ctx.app[app].destination;
  const targets = names.targets?.[environment] ?? [environment];
  if (targets.length === 0) {
    throw new Error(
      `No Vercel targets configured for environment "${environment}" (providers.vercel.targets).`,
    );
  }
  return {
    token: required(env, names.token),
    teamId: (names.team && env[names.team]) || undefined,
    projectId: required(env, destination.project),
    targets: [...targets],
  };
}

export async function upsert(
  { token, teamId, projectId, targets },
  { env, keys, ctx },
  { fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available for the Vercel provider.',
    );
  }
  const body = keys.map((key) => ({
    key,
    value: env[key],
    type: varType(ctx, key),
    target: targets,
  }));
  const url = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  url.searchParams.set('upsert', 'true');
  if (teamId) url.searchParams.set('teamId', teamId);

  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail =
      typeof response.text === 'function' ? await response.text() : '';
    throw new Error(
      `Vercel env upsert failed (${response.status}) for project ${projectId}.\n${detail}`,
    );
  }
  return { destination: 'vercel', projectId, keys };
}

export function required(env, variable) {
  if (typeof variable !== 'string' || variable === '') {
    throw new Error(
      'A provider needs the NAME of an environment variable in secrets.config.mjs, and got none.',
    );
  }
  const value = env[variable];
  if (!value) {
    throw new Error(
      `Missing ${variable}. Set it in the environment (or a GitHub Actions secret) before syncing.`,
    );
  }
  return value;
}
