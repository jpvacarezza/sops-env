import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_AGE_KEY_FILE,
  FIXTURE_CONFIG_FILE,
  FIXTURE_ROOT,
  fixtureCtx,
  registryCtx,
  withFixtureKey,
} from './ctx.mjs';

describe('fixtureCtx', () => {
  it('resolves the fixture project at its real root', () => {
    const ctx = fixtureCtx();

    expect(existsSync(FIXTURE_CONFIG_FILE)).toBe(true);
    expect(existsSync(FIXTURE_AGE_KEY_FILE)).toBe(true);
    expect(ctx.root).toBe(FIXTURE_ROOT);
    expect(ctx.apps).toEqual(['api', 'web']);
    expect(ctx.scopes).toEqual(['shared', 'api', 'web']);
    expect(ctx.deployableApps).toEqual(['api', 'web']);
    expect(ctx.pairs).toHaveLength(1);
    expect(ctx.notes.api.SERVICE_KEY_WEB).toMatch(/web\.SERVICE_KEY/);
  });

  it('shallow-merges overrides at the top level', () => {
    expect(fixtureCtx({ pairs: [] }).pairs).toEqual([]);
  });
});

describe('registryCtx', () => {
  it('builds apps from every non-shared scope and makes them deployable', () => {
    const ctx = registryCtx({
      shared: [],
      api: ['DATABASE_URL'],
      web: ['API_URL'],
      admin: [],
    });

    expect(ctx.scopes).toEqual(['shared', 'api', 'web', 'admin']);
    expect(ctx.apps).toEqual(['api', 'web', 'admin']);
    expect(ctx.appScopes.web).toEqual(['shared', 'web']);
    expect(ctx.deployableApps).toEqual(['api', 'web', 'admin']);
    expect(ctx.registry.api).toEqual(['DATABASE_URL']);
    expect(ctx.app.api.destination.provider).toBe('railway');
    expect(ctx.app.web.destination.provider).toBe('vercel');
  });

  it('leaves a listed app without a destination', () => {
    const ctx = registryCtx(
      { shared: [], api: [], ingest: ['I_REQ'] },
      { nonDeployable: ['ingest'] },
    );

    expect(ctx.deployableApps).toEqual(['api']);
    expect(ctx.app.ingest.destination).toBeNull();
  });

  it('takes an environment list and spreads extra into the raw config', () => {
    expect(
      registryCtx({ api: [] }, { environments: ['local', 'staging'] })
        .environments,
    ).toEqual(['local', 'staging']);
    expect(
      registryCtx({ api: [] }, { extra: { publicPrefixes: ['PUB_'] } })
        .publicPrefixes,
    ).toEqual(['PUB_']);
  });
});

describe('withFixtureKey', () => {
  it('points SOPS_AGE_KEY_FILE at the fixture identity', () => {
    expect(withFixtureKey({ PATH: 'x' })).toEqual({
      PATH: 'x',
      SOPS_AGE_KEY_FILE: FIXTURE_AGE_KEY_FILE,
    });
  });
});
