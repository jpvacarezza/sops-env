import { describe, expect, it, vi } from 'vitest';
import { parseSyncArgs, planSync, vercelVarType } from './sync-plan.mjs';
import { upsertVercelEnv } from './providers/vercel.mjs';
import { upsertRailwayVariables } from './providers/railway.mjs';

describe('parseSyncArgs', () => {
  it('defaults the app list to all deployables', () => {
    expect(parseSyncArgs(['staging'])).toEqual({
      environment: 'staging',
      apps: ['api', 'web', 'admin'],
      dryRun: false,
    });
  });

  it('accepts a single app and --dry-run anywhere', () => {
    expect(parseSyncArgs(['--dry-run', 'production', 'web'])).toEqual({
      environment: 'production',
      apps: ['web'],
      dryRun: true,
    });
  });

  it('rejects syncing local — that environment never leaves the laptop', () => {
    expect(() => parseSyncArgs(['local', 'api'])).toThrow(/local/i);
  });

  it('rejects an unknown app', () => {
    expect(() => parseSyncArgs(['staging', 'storybook'])).toThrow(/storybook/);
  });
});

describe('vercelVarType', () => {
  it('marks NEXT_PUBLIC_* as plain so the client bundle can read them', () => {
    expect(vercelVarType('NEXT_PUBLIC_SITE_URL')).toBe('plain');
  });

  it('marks everything else as sensitive', () => {
    expect(vercelVarType('TRIPGENCY_INTERNAL_API_KEY')).toBe('sensitive');
    expect(vercelVarType('TRIPGENCY_API_URL')).toBe('sensitive');
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
      TRIPGENCY_INTERNAL_API_KEY_WEB: 'w'.repeat(32),
      TRIPGENCY_INTERNAL_API_KEY_ADMIN: 'a'.repeat(32),
    },
    web: {
      TRIPGENCY_API_URL: 'https://api.example.test',
      TRIPGENCY_INTERNAL_API_KEY: 'w'.repeat(32),
      ENABLED_COUNTRIES: 'AR,CO',
      NEXT_PUBLIC_SITE_URL: 'https://example.test',
    },
    admin: {
      TRIPGENCY_API_URL: 'https://api.example.test',
      TRIPGENCY_INTERNAL_API_KEY: 'a'.repeat(32),
    },
  };

  it('routes api to Railway and web/admin to Vercel, listing key names only', () => {
    const plan = planSync(doc, {
      environment: 'staging',
      apps: ['api', 'web', 'admin'],
    });

    expect(plan.map((row) => row.destination)).toEqual([
      'railway/api',
      'vercel/web',
      'vercel/admin',
    ]);
    expect(plan[0].keys).toContain('DATABASE_URL');
    expect(plan[0].keys).toContain('TRIPGENCY_INTERNAL_API_KEY_WEB');
    expect(plan[0].keys).toContain('TRIPGENCY_INTERNAL_API_KEY_ADMIN');
    expect(plan[0].keys).not.toContain('TRIPGENCY_INTERNAL_API_KEY');
    expect(plan[1].keys).toContain('TRIPGENCY_INTERNAL_API_KEY');
    expect(plan[1].keys).not.toContain('TRIPGENCY_INTERNAL_API_KEY_WEB');
    expect(plan[2].keys).toContain('TRIPGENCY_INTERNAL_API_KEY');
    expect(plan[1].keys).toContain('NEXT_PUBLIC_SITE_URL');
    expect(plan[1].keys).not.toContain('DATABASE_URL');
    // The plan never carries values — logging a plan must be safe.
    for (const row of plan) {
      expect(row).not.toHaveProperty('env');
      expect(row).not.toHaveProperty('values');
    }
  });

  it('still exposes the projected env only through a private getter for the applicator', () => {
    const plan = planSync(doc, { environment: 'production', apps: ['web'] });
    expect(plan[0].getEnv().NEXT_PUBLIC_SITE_URL).toBe('https://example.test');
  });
});

describe('upsertVercelEnv', () => {
  it('POSTs every key with upsert=true and never puts values in the returned summary', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ created: [] }),
    }));

    const summary = await upsertVercelEnv(
      {
        token: 'tok',
        teamId: 'team_1',
        projectId: 'prj_web',
        targets: ['preview'],
        env: {
          TRIPGENCY_API_URL: 'https://api.test',
          NEXT_PUBLIC_SITE_URL: 'https://web.test',
        },
      },
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
          key: 'TRIPGENCY_API_URL',
          type: 'sensitive',
          target: ['preview'],
        }),
      ]),
    );
    expect(summary).toEqual({
      destination: 'vercel',
      projectId: 'prj_web',
      keys: ['NEXT_PUBLIC_SITE_URL', 'TRIPGENCY_API_URL'],
    });
  });

  it('surfaces the Vercel error body when the request fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":{"code":"forbidden"}}',
    }));

    await expect(
      upsertVercelEnv(
        {
          token: 'tok',
          projectId: 'prj',
          targets: ['production'],
          env: { A: '1' },
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/403/);
  });
});

describe('upsertRailwayVariables', () => {
  it('calls variableCollectionUpsert with skipDeploys so git remains the deploy signal', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { variableCollectionUpsert: true } }),
    }));

    const summary = await upsertRailwayVariables(
      {
        token: 'tok',
        projectId: 'proj',
        environmentId: 'env',
        serviceId: 'svc',
        env: { DATABASE_URL: 'postgresql://x/y', LOG_LEVEL: 'info' },
      },
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
      upsertRailwayVariables(
        {
          token: 'tok',
          projectId: 'p',
          environmentId: 'e',
          serviceId: 's',
          env: { A: '1' },
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/Not Authorized/);
  });
});
