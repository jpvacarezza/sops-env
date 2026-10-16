import { required } from './vercel.mjs';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

const UPSERT_MUTATION = `
  mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

export const name = 'railway';

export const label = (_ctx, { app }) => `railway/${app}`;

/**
 * Service and environment ids are both per environment: the project holds
 * `api.staging` and `api.production` as distinct services. A single
 * environment-independent id let a `sync production` reuse the staging service.
 */
export function resolve(ctx, { app, environment, env }) {
  const names = ctx.providerConfig.railway;
  const destination = ctx.app[app].destination;
  const serviceVariable = destination.service?.[environment];
  if (!serviceVariable) {
    throw new Error(
      `apps.${app}.destination.service has no entry for "${environment}" in secrets.config.mjs.`,
    );
  }
  const environmentVariable = names.environment?.[environment];
  if (!environmentVariable) {
    throw new Error(
      `providers.railway.environment has no entry for "${environment}" in secrets.config.mjs.`,
    );
  }
  return {
    token: required(env, names.token),
    projectId: required(env, names.project),
    serviceId: required(env, serviceVariable),
    environmentId: required(env, environmentVariable),
  };
}

/**
 * Upsert a flat env map onto one Railway service + environment.
 *
 * `skipDeploys: true` — ADR-0018's deploy signal is git (`main` / `v*`), not a
 * variable write. The next deploy picks up the new values. `replace` is left
 * false so keys we do not manage (Railway-injected `RAILWAY_*`, Postgres
 * references) are not deleted.
 */
export async function upsert(
  { token, projectId, environmentId, serviceId },
  { env, keys },
  { fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available for the Railway provider.',
    );
  }

  const response = await fetchImpl(RAILWAY_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: UPSERT_MUTATION,
      variables: {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables: Object.fromEntries(keys.map((key) => [key, env[key]])),
          skipDeploys: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail =
      typeof response.text === 'function' ? await response.text() : '';
    throw new Error(
      `Railway variable upsert failed (HTTP ${response.status}).\n${detail}`,
    );
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `Railway variable upsert failed: ${payload.errors.map((error) => error.message).join('; ')}`,
    );
  }

  return {
    destination: 'railway',
    projectId,
    environmentId,
    serviceId,
    keys,
  };
}
