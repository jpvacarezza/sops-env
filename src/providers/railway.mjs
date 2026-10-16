const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

const UPSERT_MUTATION = `
  mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

/**
 * Upsert a flat env map onto one Railway service + environment.
 *
 * `skipDeploys: true` — ADR-0018's deploy signal is git (`main` / `v*`), not a
 * variable write. The next deploy picks up the new values. `replace` is left
 * false so keys we do not manage (Railway-injected `RAILWAY_*`, Postgres
 * references) are not deleted.
 */
export async function upsertRailwayVariables(
  { token, projectId, environmentId, serviceId, env },
  { fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available for the Railway provider.',
    );
  }

  const keys = Object.keys(env).sort();
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
