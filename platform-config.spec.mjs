import { describe, expect, it } from 'vitest';
import {
  resolveRailwayConfig,
  resolveVercelConfig,
} from './platform-config.mjs';

describe('resolveVercelConfig', () => {
  const base = {
    VERCEL_TOKEN: 'tok',
    VERCEL_ORG_ID: 'team',
    VERCEL_PROJECT_ID_WEB: 'prj_web',
    VERCEL_PROJECT_ID_ADMIN: 'prj_admin',
  };

  it('picks the web project id and defaults staging to preview', () => {
    expect(resolveVercelConfig('web', 'staging', base)).toEqual({
      token: 'tok',
      teamId: 'team',
      projectId: 'prj_web',
      targets: ['preview'],
    });
  });

  it('defaults production to the production target', () => {
    expect(resolveVercelConfig('admin', 'production', base).targets).toEqual([
      'production',
    ]);
  });

  it('names the missing variable', () => {
    expect(() => resolveVercelConfig('web', 'staging', {})).toThrow(
      /VERCEL_TOKEN/,
    );
  });
});

describe('resolveRailwayConfig', () => {
  const base = {
    RAILWAY_TOKEN: 'tok',
    RAILWAY_PROJECT_ID: 'proj',
    RAILWAY_SERVICE_ID_API: 'svc',
    RAILWAY_ENVIRONMENT_ID_STAGING: 'env_s',
    RAILWAY_ENVIRONMENT_ID_PRODUCTION: 'env_p',
  };

  it('selects the staging environment id', () => {
    expect(resolveRailwayConfig('staging', base).environmentId).toBe('env_s');
  });

  it('selects the production environment id', () => {
    expect(resolveRailwayConfig('production', base).environmentId).toBe(
      'env_p',
    );
  });
});
