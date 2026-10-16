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
  it('fills tripgency-equal defaults and derives the lists', () => {
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
      'age1rqjglf0dpp609kmwene07v66n5zempedl8d8dmpjfg4x0pdly4vqhe7pwu',
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
