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
    RAILWAY_SERVICE_ID_API_STAGING: 'svc_s',
    RAILWAY_SERVICE_ID_API_PRODUCTION: 'svc_p',
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

  it('selects the staging service id', () => {
    expect(resolveRailwayConfig('staging', base).serviceId).toBe('svc_s');
  });

  it('selects the production service id', () => {
    expect(resolveRailwayConfig('production', base).serviceId).toBe('svc_p');
  });

  // The Railway project here holds one service per environment — `api.staging`
  // and `api.production` are distinct ids, not one service spanning both. A
  // single environment-independent variable let a `sync production` run reuse
  // the staging service id and report success while writing to the wrong
  // service, so the name has to carry the environment the way the environment
  // id already does.
  const without = (key) =>
    Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));

  it('refuses a production sync when only the staging service id is set', () => {
    expect(() =>
      resolveRailwayConfig(
        'production',
        without('RAILWAY_SERVICE_ID_API_PRODUCTION'),
      ),
    ).toThrow(/RAILWAY_SERVICE_ID_API_PRODUCTION/);
  });

  it('refuses a staging sync when only the production service id is set', () => {
    expect(() =>
      resolveRailwayConfig(
        'staging',
        without('RAILWAY_SERVICE_ID_API_STAGING'),
      ),
    ).toThrow(/RAILWAY_SERVICE_ID_API_STAGING/);
  });
});
