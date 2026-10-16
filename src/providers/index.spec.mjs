import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import { BUILTIN_PROVIDERS, destinationFor, providerFor } from './index.mjs';
import * as railway from './railway.mjs';
import * as vercel from './vercel.mjs';

describe('providerFor / destinationFor', () => {
  const ctx = fixtureCtx();

  it('returns the builtin module named by the destination', () => {
    expect(providerFor(ctx, 'api')).toBe(BUILTIN_PROVIDERS.railway);
    expect(providerFor(ctx, 'web')).toBe(BUILTIN_PROVIDERS.vercel);
  });

  it('labels byte for byte as the original in-repo tool printed them', () => {
    expect(destinationFor(ctx, 'api')).toBe('railway/api');
    expect(destinationFor(ctx, 'web')).toBe('vercel/web');
  });

  it('is null for an app with no destination', () => {
    const without = registryCtx(
      { shared: [], ingest: [] },
      { nonDeployable: ['ingest'] },
    );
    expect(providerFor(without, 'ingest')).toBeNull();
    expect(destinationFor(without, 'ingest')).toBeNull();
  });

  it('uses an inline provider from the config', () => {
    const fly = {
      name: 'fly',
      label: (_ctx, { app }) => `fly/${app}`,
      resolve: () => ({}),
      upsert: async () => ({}),
    };
    const custom = fixtureCtx({
      apps: {
        api: { scopes: ['shared', 'api'], destination: { provider: fly } },
        web: { scopes: ['shared', 'web'] },
      },
    });
    expect(destinationFor(custom, 'api')).toBe('fly/api');
  });
});

describe('vercel.resolve', () => {
  const ctx = fixtureCtx();
  const base = {
    VERCEL_TOKEN: 'tok',
    VERCEL_ORG_ID: 'team',
    VERCEL_PROJECT_ID_WEB: 'prj_web',
  };

  it('reads the names from config and the values from env; staging goes to preview', () => {
    expect(
      vercel.resolve(ctx, { app: 'web', environment: 'staging', env: base }),
    ).toEqual({
      token: 'tok',
      teamId: 'team',
      projectId: 'prj_web',
      targets: ['preview'],
    });
  });

  it('defaults production to the production target and team to undefined', () => {
    const { VERCEL_ORG_ID, ...noTeam } = base;
    expect(
      vercel.resolve(ctx, {
        app: 'web',
        environment: 'production',
        env: noTeam,
      }),
    ).toMatchObject({ teamId: undefined, targets: ['production'] });
  });

  it('names the missing variable', () => {
    expect(() =>
      vercel.resolve(ctx, { app: 'web', environment: 'staging', env: {} }),
    ).toThrow(/Missing VERCEL_TOKEN\. Set it in the environment/);
    expect(() =>
      vercel.resolve(ctx, {
        app: 'web',
        environment: 'staging',
        env: { VERCEL_TOKEN: 't' },
      }),
    ).toThrow(/Missing VERCEL_PROJECT_ID_WEB/);
  });

  it('takes renamed variables from providerConfig', () => {
    const renamed = fixtureCtx({
      providers: {
        vercel: {
          token: 'VC_TOKEN',
          team: 'VC_TEAM',
          targets: {
            staging: ['preview', 'development'],
            production: ['production'],
          },
        },
      },
    });
    expect(
      vercel.resolve(renamed, {
        app: 'web',
        environment: 'staging',
        env: { VC_TOKEN: 't', VERCEL_PROJECT_ID_WEB: 'p' },
      }),
    ).toEqual({
      token: 't',
      teamId: undefined,
      projectId: 'p',
      targets: ['preview', 'development'],
    });
  });
});

describe('railway.resolve', () => {
  const ctx = fixtureCtx();
  const base = {
    RAILWAY_TOKEN: 'tok',
    RAILWAY_PROJECT_ID: 'proj',
    RAILWAY_SERVICE_ID_API_STAGING: 'svc_s',
    RAILWAY_SERVICE_ID_API_PRODUCTION: 'svc_p',
    RAILWAY_ENVIRONMENT_ID_STAGING: 'env_s',
    RAILWAY_ENVIRONMENT_ID_PRODUCTION: 'env_p',
  };

  it('selects the per-environment service and environment ids', () => {
    expect(
      railway.resolve(ctx, { app: 'api', environment: 'staging', env: base }),
    ).toEqual({
      token: 'tok',
      projectId: 'proj',
      serviceId: 'svc_s',
      environmentId: 'env_s',
    });
    expect(
      railway.resolve(ctx, {
        app: 'api',
        environment: 'production',
        env: base,
      }),
    ).toMatchObject({ serviceId: 'svc_p', environmentId: 'env_p' });
  });

  it('refuses a production sync when only the staging service id is set', () => {
    const { RAILWAY_SERVICE_ID_API_PRODUCTION, ...onlyStaging } = base;
    expect(() =>
      railway.resolve(ctx, {
        app: 'api',
        environment: 'production',
        env: onlyStaging,
      }),
    ).toThrow(/RAILWAY_SERVICE_ID_API_PRODUCTION/);
  });

  it('refuses an environment the destination has no service for', () => {
    expect(() =>
      railway.resolve(ctx, { app: 'api', environment: 'local', env: base }),
    ).toThrow(/apps\.api\.destination\.service has no entry for "local"/);
  });
});
