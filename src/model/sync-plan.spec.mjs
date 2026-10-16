import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import { varType } from '../providers/vercel.mjs';
import { destinationFor, parseSyncArgs } from './sync-plan.mjs';

const ctx = registryCtx(
  { shared: [], api: [], web: [], admin: [], ingest: [] },
  { nonDeployable: ['ingest'] },
);

describe('parseSyncArgs and the deployable list', () => {
  it('syncs the deployable apps by default and never ingest', () => {
    const { apps } = parseSyncArgs(ctx, ['staging']);
    expect(apps).toEqual([...ctx.deployableApps]);
    expect(apps).not.toContain('ingest');
  });

  it('refuses an app with no destination by name, and all skips it', () => {
    expect(() => parseSyncArgs(ctx, ['staging', 'ingest'])).toThrow(
      /Unknown app "ingest"\. Expected one of: api, web, admin, all/,
    );
    expect(parseSyncArgs(ctx, ['staging']).apps).toEqual([
      'api',
      'web',
      'admin',
    ]);
  });

  it('refuses an environment marked sync: false, naming the config', () => {
    expect(() => parseSyncArgs(ctx, ['local'])).toThrow(
      /Refusing to sync "local"[\s\S]*secrets\.config\.mjs/,
    );
  });
});

describe('vercel varType', () => {
  it('respects a custom public prefix', () => {
    const custom = fixtureCtx({ publicPrefixes: ['PUBLIC_'] });
    expect(varType(custom, 'PUBLIC_X')).toBe('plain');
    expect(varType(custom, 'NEXT_PUBLIC_X')).toBe('sensitive');
  });
});

describe('destinationFor', () => {
  it('names provider/app for a deployable app and null for one without', () => {
    expect(destinationFor(ctx, 'api')).toBe('railway/api');
    expect(destinationFor(ctx, 'web')).toBe('vercel/web');
    expect(destinationFor(ctx, 'ingest')).toBeNull();
  });
});
