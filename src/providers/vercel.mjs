import { vercelVarType } from '../model/sync-plan.mjs';

/**
 * Upsert a flat env map onto a Vercel project.
 *
 * Uses `/v10/.../env?upsert=true` so a second sync updates values instead of
 * failing with ENV_CONFLICT. Values are never returned in the summary.
 */
export async function upsertVercelEnv(
  { token, teamId, projectId, targets, env, ctx },
  { fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available for the Vercel provider.',
    );
  }

  const keys = Object.keys(env).sort();
  const body = keys.map((key) => ({
    key,
    value: env[key],
    type: vercelVarType(ctx, key),
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
