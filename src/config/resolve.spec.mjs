import { describe, expect, it } from 'vitest';

import { resolveConfig } from './resolve.mjs';

const ROOT = '/repo';
const FILE = '/repo/secrets.config.mjs';

/** The smallest config that resolves: one scope, one app. */
const minimal = () => ({
  scopes: { shared: { keys: {} }, api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['shared', 'api'] } },
});

const resolve = (raw, options = {}) =>
  resolveConfig(raw, { root: ROOT, configFile: FILE, ...options });

describe('resolveConfig', () => {
  it('fills the original defaults and derives the lists', () => {
    const ctx = resolve(minimal());

    expect(ctx.environments).toEqual(['local', 'staging', 'production']);
    expect(ctx.syncable).toEqual(['staging', 'production']);
    expect(ctx.nodeEnv).toEqual({
      local: 'development',
      staging: 'staging',
      production: 'production',
    });
    expect(ctx.scopes).toEqual(['shared', 'api']);
    expect(ctx.registry).toEqual({ shared: [], api: ['DATABASE_URL'] });
    expect(ctx.notes).toEqual({ shared: {}, api: { DATABASE_URL: null } });
    expect(ctx.apps).toEqual(['api']);
    expect(ctx.appScopes).toEqual({ api: ['shared', 'api'] });
    expect(ctx.deployableApps).toEqual([]);
    expect(ctx.app.api).toEqual({
      scopes: ['shared', 'api'],
      dotenv: 'apps/api/.env.local',
      example: 'apps/api/.env.example',
      schema: null,
      destination: null,
    });
    expect(ctx.pairs).toEqual([]);
    expect(ctx.notDriftWhenUnset).toEqual({});
    expect(ctx.publicPrefixes).toEqual(['NEXT_PUBLIC_']);
    expect(ctx.placeholderPattern.test('REPLACE_ME')).toBe(true);
    expect(ctx.store).toEqual({
      dir: 'secrets',
      file: '<environment>.enc.yaml',
      sopsConfig: '.sops.yaml',
      tracked: ['README.md', 'STAGING-PROD-CHECKLIST.md'],
    });
    expect(ctx.schemaRunner).toEqual({
      runner: 'tsx',
      conditions: [],
      cwd: 'tmp',
    });
    expect(ctx.contract.sourceRoots).toEqual(['apps/*/src']);
    expect(ctx.providerConfig.vercel.token).toBe('VERCEL_TOKEN');
    expect(ctx.root).toBe(ROOT);
    expect(ctx.configFile).toBe(FILE);
  });

  it('keeps the environment order the file wrote', () => {
    const ctx = resolve({
      ...minimal(),
      environments: {
        production: { nodeEnv: 'production', sync: true },
        local: { nodeEnv: 'development', sync: false },
      },
    });

    expect(ctx.environments).toEqual(['production', 'local']);
    expect(ctx.syncable).toEqual(['production']);
  });

  it('marks an app deployable when it has a destination', () => {
    const raw = minimal();
    raw.apps.api.destination = {
      provider: 'railway',
      service: { staging: 'S', production: 'P' },
    };
    raw.apps.web = { scopes: ['shared'] };

    expect(resolve(raw).deployableApps).toEqual(['api']);
    expect(resolve(raw).apps).toEqual(['api', 'web']);
  });

  it('unions the three exemption maps into notDriftWhenUnset', () => {
    const ctx = resolve({
      ...minimal(),
      exemptions: {
        unparsedBySchema: { A: 'a' },
        platformProvided: { B: 'b' },
        derived: { C: 'c' },
      },
    });

    expect(ctx.notDriftWhenUnset).toEqual({ A: 'a', B: 'b', C: 'c' });
    expect(ctx.exemptions.derived).toEqual({ C: 'c' });
  });

  it('is deep-frozen', () => {
    const ctx = resolve(minimal());

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.registry.api)).toBe(true);
    expect(Object.isFrozen(ctx.app.api)).toBe(true);
    expect(() => {
      ctx.registry.api.push('X');
    }).toThrow();
  });

  it('relative() is posix and rooted at root', () => {
    const ctx = resolve(minimal());

    expect(ctx.relative('/repo/secrets/local.enc.yaml')).toBe(
      'secrets/local.enc.yaml',
    );
  });

  it('names the field of an undeclared scope', () => {
    const raw = minimal();
    raw.apps.web = { scopes: ['shared', 'shred'] };

    expect(() => resolve(raw)).toThrow(
      /apps\.web\.scopes\[1\]: "shred" is not a declared scope/,
    );
  });

  it('requires at least one app and one scope', () => {
    expect(() => resolve({ scopes: {}, apps: {} })).toThrow(
      /scopes: declare at least one scope/,
    );
    expect(() => resolve({ scopes: { api: { keys: {} } }, apps: {} })).toThrow(
      /apps: declare at least one app/,
    );
  });

  it('refuses a key declared in both shared and an app scope', () => {
    const raw = minimal();
    raw.scopes.shared.keys.DATABASE_URL = null;

    expect(() => resolve(raw)).toThrow(
      /"DATABASE_URL" is declared in both "shared" and "api"; those scopes merge/,
    );
  });

  // Review Focus 1.
  it('refuses a store.file without the <environment> placeholder', () => {
    expect(() =>
      resolve({ ...minimal(), store: { file: 'secrets.enc.yaml' } }),
    ).toThrow(/store\.file: "secrets\.enc\.yaml" must contain <environment>/);
  });

  // Review Focus 2: the names-only guard.
  it.each([
    [42, 'must be a string or null, got number'],
    [
      'age19pu4qdgn4eu88pkf3vuvpc6r8gjhyyuxcxsnh9kyn3nrsvrfqatq6gek4m',
      'looks like a key or a value',
    ],
    ['AGE-SECRET-KEY-1ABC', 'looks like a key or a value'],
    ['ENC[AES256_GCM,data:x]', 'looks like a key or a value'],
    ['postgresql://u:p@h/db?sslmode=require', 'contains "="'],
  ])('rejects the key entry %j as a note', (entry, reason) => {
    const raw = minimal();
    raw.scopes.api.keys.DATABASE_URL = entry;

    expect(() => resolve(raw)).toThrow(
      new RegExp(`scopes\\.api\\.keys\\.DATABASE_URL: .*${reason}`),
    );
  });

  it('refuses a key that is not UPPER_SNAKE_CASE', () => {
    const raw = minimal();
    raw.scopes.api.keys.databaseUrl = null;

    expect(() => resolve(raw)).toThrow(
      /scopes\.api\.keys\.databaseUrl: not an environment variable name/,
    );
  });

  it('refuses a pair that names an undeclared key', () => {
    const raw = minimal();
    raw.pairs = [
      {
        name: 'x',
        left: { scope: 'api', key: 'DATABASE_URL' },
        right: { scope: 'api', key: 'NOPE' },
        relation: 'equal',
        why: 'because',
      },
    ];

    expect(() => resolve(raw)).toThrow(
      /pairs\[0\]\.right: api\.NOPE is not a declared key/,
    );
  });

  it('refuses a schema entry without file and exportName', () => {
    const raw = minimal();
    raw.apps.api.schema = { file: 'apps/api/src/env.ts' };

    expect(() => resolve(raw)).toThrow(
      /apps\.api\.schema\.exportName: required/,
    );
  });

  it('normalises an inline provider object to its name and registers it', () => {
    const custom = {
      name: 'fly',
      label: () => 'fly/api',
      resolve: () => ({}),
      upsert: async () => ({}),
    };
    const raw = minimal();
    raw.apps.api.destination = { provider: custom };

    const ctx = resolve(raw);

    expect(ctx.app.api.destination.provider).toBe('fly');
    expect(ctx.providers.fly).toBe(custom);
  });

  it('refuses a destination whose provider is not registered when providers are given', () => {
    const raw = minimal();
    raw.apps.api.destination = { provider: 'heroku' };

    expect(() => resolve(raw, { providers: { vercel: {} } })).toThrow(
      /apps\.api\.destination\.provider: "heroku" is not a known provider \(known: vercel\)/,
    );
  });

  it('lists every problem at once', () => {
    const raw = {
      scopes: { api: { keys: { x: 1 } } },
      apps: { web: { scopes: ['nope'] } },
    };

    const lines = (() => {
      try {
        resolve(raw);
      } catch (error) {
        return error.message.split('\n');
      }
      return [];
    })();

    expect(lines[0]).toBe('Invalid secrets.config.mjs:');
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('resolveConfig: names-only guard beyond scope notes', () => {
  const NOT_A_NAME = 'vcp_live_0123456789abcdef';

  it.each([
    ['vercel', 'token'],
    ['vercel', 'team'],
    ['railway', 'token'],
    ['railway', 'project'],
  ])(
    'rejects providers.%s.%s that is not an env-var name',
    (provider, field) => {
      const raw = {
        ...minimal(),
        providers: { [provider]: { [field]: NOT_A_NAME } },
      };

      expect(() => resolve(raw)).toThrow(
        new RegExp(
          `providers\\.${provider}\\.${field}: not an environment variable name`,
        ),
      );
    },
  );

  it('rejects a providers.railway.environment entry that is not a name', () => {
    const raw = {
      ...minimal(),
      providers: { railway: { environment: { staging: NOT_A_NAME } } },
    };

    expect(() => resolve(raw)).toThrow(
      /providers\.railway\.environment\.staging: not an environment variable name/,
    );
  });

  it('never echoes the rejected string', () => {
    const raw = { ...minimal(), providers: { vercel: { token: NOT_A_NAME } } };

    let message = '';
    try {
      resolve(raw);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/providers\.vercel\.token/);
    expect(message).not.toContain(NOT_A_NAME);
  });

  it('rejects a destination project or service entry that is not a name', () => {
    const raw = minimal();
    raw.scopes.web = { keys: {} };
    raw.apps.web = {
      scopes: ['web'],
      destination: { provider: 'vercel', project: 'prj_abc123' },
    };
    raw.apps.api.destination = {
      provider: 'railway',
      service: { staging: 'S', production: 'svc-1234' },
    };

    expect(() => resolve(raw)).toThrow(
      /apps\.web\.destination\.project: not an environment variable name/,
    );
    expect(() => resolve(raw)).toThrow(
      /apps\.api\.destination\.service\.production: not an environment variable name/,
    );
  });

  it('runs the note guard over pair name and why', () => {
    const raw = minimal();
    raw.scopes.api.keys.OTHER = null;
    raw.pairs = [
      {
        name: 'AGE-SECRET-KEY-1XYZ',
        left: { scope: 'api', key: 'DATABASE_URL' },
        right: { scope: 'api', key: 'OTHER' },
        relation: 'equal',
        why: 'TOKEN=abc',
      },
    ];

    expect(() => resolve(raw)).toThrow(
      /pairs\[0\]\.name: looks like a key or a value/,
    );
    expect(() => resolve(raw)).toThrow(/pairs\[0\]\.why: contains "="/);
  });

  it.each(['unparsedBySchema', 'platformProvided', 'derived'])(
    'runs the note guard over exemptions.%s reasons',
    (group) => {
      const raw = {
        ...minimal(),
        exemptions: { [group]: { CI: 'ENC[AES256_GCM,data:x]' } },
      };

      expect(() => resolve(raw)).toThrow(
        new RegExp(`exemptions\\.${group}\\.CI: looks like a key or a value`),
      );
    },
  );
});

describe('resolveConfig: provider shape', () => {
  it.each(['label', 'resolve', 'upsert'])(
    'rejects an inline provider whose %s is not a function',
    (field) => {
      const custom = {
        name: 'fly',
        label: () => 'fly/api',
        resolve: () => ({}),
        upsert: async () => ({}),
        [field]: 'nope',
      };
      const raw = minimal();
      raw.apps.api.destination = { provider: custom };

      expect(() => resolve(raw)).toThrow(
        new RegExp(`providers\\.fly\\.${field} is not a function`),
      );
    },
  );
});

describe('resolveConfig: providerConfig', () => {
  it('merges a partial override over the builtin defaults, one level deep', () => {
    const ctx = resolve({
      ...minimal(),
      providers: {
        vercel: { token: 'MY_TOKEN' },
        railway: { environment: { staging: 'MY_RAILWAY_STAGING' } },
      },
    });

    expect(ctx.providerConfig.vercel).toEqual({
      token: 'MY_TOKEN',
      team: 'VERCEL_ORG_ID',
      targets: { staging: ['preview'], production: ['production'] },
    });
    expect(ctx.providerConfig.vercel.targets.staging).toEqual(['preview']);
    expect(ctx.providerConfig.railway.environment).toEqual({
      staging: 'MY_RAILWAY_STAGING',
      production: 'RAILWAY_ENVIRONMENT_ID_PRODUCTION',
    });
    expect(ctx.providerConfig.railway.token).toBe('RAILWAY_TOKEN');
  });

  it.each([
    [{ vercel: 'VERCEL_TOKEN' }, /providers\.vercel: must be an object/],
    [
      { vercel: { targets: { staging: 'preview' } } },
      /providers\.vercel\.targets\.staging: must be an array of strings/,
    ],
    [{ vercel: { token: 42 } }, /providers\.vercel\.token: must be a string/],
    [
      { fly: { app: 7 } },
      /providers\.fly\.app: must be a string, an array of strings, or an object of those/,
    ],
  ])('rejects a malformed providers block %j', (providers, message) => {
    expect(() => resolve({ ...minimal(), providers })).toThrow(message);
  });
});

describe('resolveConfig: builtin providers by default', () => {
  it('resolves vercel and railway with no providers option', () => {
    const raw = minimal();
    raw.scopes.web = { keys: {} };
    raw.apps.web = {
      scopes: ['web'],
      destination: { provider: 'vercel', project: 'VERCEL_PROJECT_ID_WEB' },
    };
    raw.apps.api.destination = {
      provider: 'railway',
      service: { staging: 'S', production: 'P' },
    };

    const ctx = resolve(raw);

    expect(Object.keys(ctx.providers)).toEqual(['vercel', 'railway']);
    expect(ctx.providers.vercel.label(ctx, { app: 'web' })).toBe('vercel/web');
  });

  it('rejects an unknown provider with no providers option', () => {
    const raw = minimal();
    raw.apps.api.destination = { provider: 'heroku' };

    expect(() => resolve(raw)).toThrow(
      /"heroku" is not a known provider \(known: vercel, railway\)/,
    );
  });
});

describe('resolveConfig: store and environment names', () => {
  it.each([
    ['nested/<environment>.enc.yaml', /store\.file: .*path separator/],
    ['nested\\<environment>.enc.yaml', /store\.file: .*path separator/],
    ['..<environment>.enc.yaml', /store\.file: .*"\.\."/],
    [
      '<environment>-<environment>.enc.yaml',
      /store\.file: .*exactly one <environment>/,
    ],
  ])('rejects store.file %j', (file, message) => {
    expect(() => resolve({ ...minimal(), store: { file } })).toThrow(message);
  });

  it.each(['../secrets', '/abs/secrets', ''])('rejects store.dir %j', (dir) => {
    expect(() => resolve({ ...minimal(), store: { dir } })).toThrow(
      /store\.dir: /,
    );
  });

  it.each(['Local', 'pre_prod', '1st', 'a/b'])(
    'rejects the environment name %j',
    (name) => {
      const raw = {
        ...minimal(),
        environments: { [name]: { nodeEnv: 'development', sync: false } },
      };

      expect(() => resolve(raw)).toThrow(
        new RegExp(`environments\\.${escapeForRegExp(name)}: name must match`),
      );
    },
  );

  it('accepts a lowercase, dashed environment name', () => {
    const raw = {
      ...minimal(),
      environments: { 'pre-prod': { nodeEnv: 'production', sync: true } },
    };

    expect(resolve(raw).environments).toEqual(['pre-prod']);
  });
});

describe('resolveConfig: dotenv stays under root', () => {
  it.each(['../outside/.env.local', '/elsewhere/.env.local'])(
    'rejects apps.api.dotenv %j',
    (dotenv) => {
      const raw = minimal();
      raw.apps.api.dotenv = dotenv;

      expect(() => resolve(raw)).toThrow(
        /apps\.api\.dotenv: resolves outside the config root/,
      );
    },
  );

  it('accepts a dotenv under root', () => {
    const raw = minimal();
    raw.apps.api.dotenv = 'services/api/.env';

    expect(resolve(raw).app.api.dotenv).toBe('services/api/.env');
  });
});
