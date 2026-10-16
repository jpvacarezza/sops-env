import { describe, expect, it, vi } from 'vitest';
import { registryCtx } from '../../test/helpers/ctx.mjs';
import { parseSyncArgs, planSync } from '../model/sync-plan.mjs';
import * as railway from '../providers/railway.mjs';
import * as vercel from '../providers/vercel.mjs';

const { varType } = vercel;

const CTX = registryCtx(
  { shared: [], api: [], web: [], admin: [], ingest: [] },
  { nonDeployable: ['ingest'] },
);

describe('parseSyncArgs', () => {
  it('defaults the app list to all deployables', () => {
    expect(parseSyncArgs(CTX, ['staging'])).toEqual({
      environment: 'staging',
      apps: ['api', 'web', 'admin'],
      dryRun: false,
    });
  });

  it('accepts a single app and --dry-run anywhere', () => {
    expect(parseSyncArgs(CTX, ['--dry-run', 'production', 'web'])).toEqual({
      environment: 'production',
      apps: ['web'],
      dryRun: true,
    });
  });

  it('rejects syncing local — that environment never leaves the laptop', () => {
    expect(() => parseSyncArgs(CTX, ['local', 'api'])).toThrow(/local/i);
  });

  it('rejects an unknown app', () => {
    expect(() => parseSyncArgs(CTX, ['staging', 'storybook'])).toThrow(
      /storybook/,
    );
  });
});

describe('vercel varType', () => {
  it('marks NEXT_PUBLIC_* as plain so the client bundle can read them', () => {
    expect(varType(CTX, 'NEXT_PUBLIC_SITE_URL')).toBe('plain');
  });

  it('marks everything else as sensitive', () => {
    expect(varType(CTX, 'INTERNAL_API_KEY')).toBe('sensitive');
    expect(varType(CTX, 'API_URL')).toBe('sensitive');
  });
});

describe('planSync', () => {
  const doc = {
    shared: {},
    api: {
      DATABASE_URL: 'postgresql://x/y',
      BETTER_AUTH_SECRET: 's'.repeat(20),
      BETTER_AUTH_URL: 'https://example.test',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://example.test',
      SECURITY_EVENT_IP_SALT: 't'.repeat(32),
      TRUST_PROXY: '1',
      SWAGGER_ENABLED: 'false',
      INTERNAL_API_KEY_WEB: 'w'.repeat(32),
      INTERNAL_API_KEY_ADMIN: 'a'.repeat(32),
    },
    web: {
      API_URL: 'https://api.example.test',
      INTERNAL_API_KEY: 'w'.repeat(32),
      ENABLED_COUNTRIES: 'AR,CO',
      NEXT_PUBLIC_SITE_URL: 'https://example.test',
    },
    admin: {
      API_URL: 'https://api.example.test',
      INTERNAL_API_KEY: 'a'.repeat(32),
    },
  };

  const PLAN_CTX = registryCtx({
    shared: [],
    api: Object.keys(doc.api),
    web: Object.keys(doc.web),
    admin: Object.keys(doc.admin),
  });

  it('routes api to Railway and web/admin to Vercel, listing key names only', () => {
    const plan = planSync(PLAN_CTX, doc, {
      environment: 'staging',
      apps: ['api', 'web', 'admin'],
    });

    expect(plan.map((row) => row.destination)).toEqual([
      'railway/api',
      'vercel/web',
      'vercel/admin',
    ]);
    expect(plan[0].keys).toContain('DATABASE_URL');
    expect(plan[0].keys).toContain('INTERNAL_API_KEY_WEB');
    expect(plan[0].keys).toContain('INTERNAL_API_KEY_ADMIN');
    expect(plan[0].keys).not.toContain('INTERNAL_API_KEY');
    expect(plan[1].keys).toContain('INTERNAL_API_KEY');
    expect(plan[1].keys).not.toContain('INTERNAL_API_KEY_WEB');
    expect(plan[2].keys).toContain('INTERNAL_API_KEY');
    expect(plan[1].keys).toContain('NEXT_PUBLIC_SITE_URL');
    expect(plan[1].keys).not.toContain('DATABASE_URL');
    // The plan never carries values — logging a plan must be safe.
    for (const row of plan) {
      expect(row).not.toHaveProperty('env');
      expect(row).not.toHaveProperty('values');
    }
  });

  it('still exposes the projected env only through a private getter for the applicator', () => {
    const plan = planSync(PLAN_CTX, doc, {
      environment: 'production',
      apps: ['web'],
    });
    expect(plan[0].getEnv().NEXT_PUBLIC_SITE_URL).toBe('https://example.test');
  });
});

describe('vercel.upsert', () => {
  it('POSTs every key with upsert=true and never puts values in the returned summary', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ created: [] }),
    }));

    const env = {
      API_URL: 'https://api.test',
      NEXT_PUBLIC_SITE_URL: 'https://web.test',
    };
    const summary = await vercel.upsert(
      {
        token: 'tok',
        teamId: 'team_1',
        projectId: 'prj_web',
        targets: ['preview'],
      },
      { env, keys: Object.keys(env).sort(), ctx: CTX },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/v10/projects/prj_web/env?upsert=true');
    expect(url).toContain('teamId=team_1');
    expect(init.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'NEXT_PUBLIC_SITE_URL',
          type: 'plain',
          target: ['preview'],
        }),
        expect.objectContaining({
          key: 'API_URL',
          type: 'sensitive',
          target: ['preview'],
        }),
      ]),
    );
    expect(summary).toEqual({
      destination: 'vercel',
      projectId: 'prj_web',
      keys: ['API_URL', 'NEXT_PUBLIC_SITE_URL'],
    });
  });

  it('surfaces the Vercel error body when the request fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":{"code":"forbidden"}}',
    }));

    await expect(
      vercel.upsert(
        { token: 'tok', projectId: 'prj', targets: ['production'] },
        { env: { A: '1' }, keys: ['A'], ctx: CTX },
        { fetchImpl },
      ),
    ).rejects.toThrow(/403/);
  });
});

describe('railway.upsert', () => {
  it('calls variableCollectionUpsert with skipDeploys so git remains the deploy signal', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { variableCollectionUpsert: true } }),
    }));

    const env = { DATABASE_URL: 'postgresql://x/y', LOG_LEVEL: 'info' };
    const summary = await railway.upsert(
      {
        token: 'tok',
        projectId: 'proj',
        environmentId: 'env',
        serviceId: 'svc',
      },
      { env, keys: Object.keys(env).sort(), ctx: CTX },
      { fetchImpl },
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.query).toMatch(/variableCollectionUpsert/);
    expect(body.variables.input).toMatchObject({
      projectId: 'proj',
      environmentId: 'env',
      serviceId: 'svc',
      skipDeploys: true,
      variables: {
        DATABASE_URL: 'postgresql://x/y',
        LOG_LEVEL: 'info',
      },
    });
    expect(summary.keys).toEqual(['DATABASE_URL', 'LOG_LEVEL']);
  });

  it('fails when GraphQL returns errors', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'Not Authorized' }] }),
    }));

    await expect(
      railway.upsert(
        { token: 'tok', projectId: 'p', environmentId: 'e', serviceId: 's' },
        { env: { A: '1' }, keys: ['A'], ctx: CTX },
        { fetchImpl },
      ),
    ).rejects.toThrow(/Not Authorized/);
  });
});
