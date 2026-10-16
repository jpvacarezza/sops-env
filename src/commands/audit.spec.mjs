import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ROOT,
  fixtureCtx,
  registryCtx,
} from '../../test/helpers/ctx.mjs';
import {
  auditEnvironments,
  childEnvironment,
  findPlaceholders,
  parseAuditArgs,
  placeholderFindings,
  schemaFindings,
  validateProjection,
} from './audit.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['API_URL'],
  admin: [],
};
const CTX = registryCtx(REGISTRY);

const clean = {
  api: { DATABASE_URL: 'postgresql://real/db', LOG_LEVEL: 'info' },
  web: { API_URL: 'https://api.example.com' },
  admin: {},
};

const fixtureClean = {
  shared: { LOG_LEVEL: 'info' },
  api: { DATABASE_URL: 'postgresql://real/db' },
  web: { API_URL: 'https://api.example.com' },
};

const okValidator = () => ({ status: 0, stdout: '{"ok":true}', stderr: '' });

describe('findPlaceholders', () => {
  it('finds REPLACE_ME and change-me, whatever the case', () => {
    const document = {
      api: { DATABASE_URL: 'postgresql://user:REPLACE_ME@host/db' },
      web: { API_URL: 'http://CHANGE-ME' },
    };

    expect(findPlaceholders(CTX, document)).toEqual([
      { scope: 'api', key: 'DATABASE_URL' },
      { scope: 'web', key: 'API_URL' },
    ]);
  });

  it('finds nothing in a provisioned document', () => {
    expect(findPlaceholders(CTX, clean)).toEqual([]);
  });

  it('reports one finding per key, however many times the sentinel appears', () => {
    const document = {
      api: { DATABASE_URL: 'postgres://REPLACE_ME:REPLACE_ME@REPLACE_ME/db' },
    };

    expect(findPlaceholders(CTX, document)).toHaveLength(1);
  });

  it('ignores a scope that is not a mapping', () => {
    expect(findPlaceholders(CTX, { sops: null, api: {} })).toEqual([]);
  });
});

describe('placeholderFindings', () => {
  // local holds placeholders on purpose, so calling that
  // an error would train everyone to ignore the command.
  it('is only a warning in local', () => {
    const [finding] = placeholderFindings('local', [
      { scope: 'api', key: 'DATABASE_URL' },
    ]);

    expect(finding.severity).toBe('warn');
    expect(finding.message).toMatch(/deliberate/);
  });

  it('is an error in staging and production, and names the checklist', () => {
    for (const environment of ['staging', 'production']) {
      const [finding] = placeholderFindings(environment, [
        { scope: 'api', key: 'DATABASE_URL' },
      ]);

      expect(finding.severity).toBe('error');
      expect(finding.message).toMatch(/Replace it before/);
    }
  });
});

describe('childEnvironment', () => {
  const base = {
    PATH: '/usr/bin',
    DATABASE_URL: 'postgresql://from-my-shell/db',
    UNRELATED: 'keep me',
  };

  // Without the strip, a DATABASE_URL exported in your terminal satisfies a
  // schema the store cannot, and the audit reports the shell instead of the repo.
  it('strips every registry variable out of the inherited environment', () => {
    const env = childEnvironment(CTX, {}, { environment: 'staging', base });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.UNRELATED).toBe('keep me');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('applies the projection', () => {
    const env = childEnvironment(
      CTX,
      { DATABASE_URL: 'postgresql://store/db' },
      { environment: 'staging', base },
    );

    expect(env.DATABASE_URL).toBe('postgresql://store/db');
  });

  // The store sets NODE_ENV nowhere, so without this every
  // `NODE_ENV === 'production'` refinement is silently disarmed.
  it('assumes the NODE_ENV the platform will set', () => {
    // Literals, not ctx.nodeEnv: reading the same map on both sides would
    // pass with { production: 'development' }, which disarms every
    // production-only refinement — the one thing this map exists to arm.
    const expected = {
      local: 'development',
      staging: 'staging',
      production: 'production',
    };

    expect(CTX.nodeEnv).toEqual(expected);
    for (const environment of CTX.environments) {
      expect(childEnvironment(CTX, {}, { environment, base }).NODE_ENV).toBe(
        expected[environment],
      );
    }
  });

  it('lets a NODE_ENV in the store win over the assumption', () => {
    const env = childEnvironment(
      CTX,
      { NODE_ENV: 'test' },
      { environment: 'production', base },
    );

    expect(env.NODE_ENV).toBe('test');
  });

  it('maps the configured conditions to NODE_OPTIONS', () => {
    const ctx = fixtureCtx({
      schemaRunner: { conditions: ['@org/source'] },
    });
    const env = childEnvironment(ctx, {}, { environment: 'local', base });

    expect(env.NODE_OPTIONS).toContain('--conditions=@org/source');
  });

  it('keeps a developer NODE_OPTIONS and appends the conditions after it', () => {
    const ctx = fixtureCtx({
      schemaRunner: { conditions: ['@org/source'] },
    });
    const env = childEnvironment(
      ctx,
      {},
      {
        environment: 'local',
        base: { ...base, NODE_OPTIONS: '--no-warnings' },
      },
    );

    expect(env.NODE_OPTIONS).toBe('--no-warnings --conditions=@org/source');
  });

  it('leaves NODE_OPTIONS undefined when nothing configures it', () => {
    const env = childEnvironment(CTX, {}, { environment: 'local', base });

    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

describe('validateProjection', () => {
  const target = { environment: 'staging', app: 'api', document: clean };

  it('passes on a valid verdict', () => {
    expect(
      validateProjection(CTX, target, { runValidator: okValidator }),
    ).toEqual({ state: 'ok' });
  });

  it('surfaces the schema message on an invalid one', () => {
    const runValidator = () => ({
      status: 1,
      stdout:
        '{"ok":false,"kind":"invalid","message":"  - DATABASE_URL: too short"}',
      stderr: '',
    });

    expect(validateProjection(CTX, target, { runValidator })).toEqual({
      state: 'invalid',
      message: '  - DATABASE_URL: too short',
    });
  });

  // A validator that could not load its own subject has said nothing about the
  // store. Calling that `invalid` reads as "production's config is wrong" when
  // the truth is "this tool is broken", and someone would go looking at Railway.
  it('reports a module that would not load as unavailable, not invalid', () => {
    const runValidator = () => ({
      status: 1,
      stdout:
        '{"ok":false,"kind":"load","message":"Cannot find module env.schema.js"}',
      stderr: '',
    });

    expect(validateProjection(CTX, target, { runValidator }).state).toBe(
      'unavailable',
    );
  });

  // A validator that cannot run is not a pass. It is a warning that the check
  // did not happen, which is a different thing from "nothing is wrong".
  it('reports a spawn failure as unavailable, not as ok', () => {
    const runValidator = () => ({ error: new Error('spawn ENOENT') });

    expect(validateProjection(CTX, target, { runValidator }).state).toBe(
      'unavailable',
    );
  });

  it('reports unparseable output as unavailable and keeps the tail of stderr', () => {
    const runValidator = () => ({
      status: 1,
      stdout: '',
      stderr: 'SyntaxError: boom',
    });
    const outcome = validateProjection(CTX, target, { runValidator });

    expect(outcome.state).toBe('unavailable');
    expect(outcome.message).toMatch(/SyntaxError: boom/);
  });
});

describe('schemaFindings', () => {
  it('says nothing when the projection is valid', () => {
    expect(schemaFindings('staging', 'api', { state: 'ok' })).toEqual([]);
  });

  it('is an error when the app would fail at boot', () => {
    const [finding] = schemaFindings('production', 'api', {
      state: 'invalid',
      message: 'x',
    });

    expect(finding).toMatchObject({
      code: 'schema-invalid',
      severity: 'error',
    });
    expect(finding.message).toMatch(/fail at boot/);
  });

  it('is a warning when the check could not run', () => {
    const [finding] = schemaFindings('production', 'api', {
      state: 'unavailable',
      message: 'x',
    });

    expect(finding).toMatchObject({
      code: 'schema-unchecked',
      severity: 'warn',
    });
  });
});

describe('parseAuditArgs', () => {
  it('defaults to every environment with the schema pass on', () => {
    expect(parseAuditArgs(CTX, [])).toEqual({
      environments: CTX.environments,
      withSchema: true,
      help: false,
    });
  });

  it('turns the schema pass off', () => {
    expect(parseAuditArgs(CTX, ['--no-schema']).withSchema).toBe(false);
  });

  it('names the valid environments when given an unknown one', () => {
    expect(() => parseAuditArgs(CTX, ['prod'])).toThrow(
      /Unknown environment "prod"/,
    );
  });

  it('refuses an unknown flag', () => {
    expect(() => parseAuditArgs(CTX, ['--fix'])).toThrow(
      /Unknown flag "--fix"/,
    );
  });
});

describe('auditEnvironments', () => {
  it('cannot check values it cannot decrypt, and says so rather than passing', () => {
    const decrypt = () => {
      throw new Error('no identity matched any of the recipients');
    };
    const { findings, errors } = auditEnvironments(fixtureCtx(), {
      environments: ['staging'],
      withSchema: false,
      decrypt,
    });

    expect(findings.some((finding) => finding.code === 'undecryptable')).toBe(
      true,
    );
    expect(errors.some((finding) => finding.code === 'undecryptable')).toBe(
      false,
    );
  });

  it('skips the schema pass when asked, and runs it otherwise', () => {
    const calls = [];
    const runValidator = (_ctx, options) => {
      calls.push(options.app);
      return okValidator();
    };
    const decrypt = () => structuredClone(fixtureClean);

    auditEnvironments(fixtureCtx(), {
      environments: ['staging'],
      withSchema: false,
      decrypt,
      runValidator,
    });
    expect(calls).toEqual([]);

    auditEnvironments(fixtureCtx(), {
      environments: ['staging'],
      withSchema: true,
      decrypt,
      runValidator,
    });
    expect(calls).toEqual(['api', 'web']);
  });

  // The same rule `buildMatrix` applies to `missing-required`: an app with no
  // destination has no platform in `production`, so spawning its validator there
  // would only report "the projection is empty" — a fact about the store having
  // no platform to fill it from, not about the app's configuration. `local` is
  // real for every app, so it is always validated there.
  it('validates an app with no destination for local only, and a deployable one for every environment', () => {
    const ctx = registryCtx(
      {
        shared: [],
        api: ['DATABASE_URL', 'LOG_LEVEL'],
        web: ['API_URL'],
        ingest: [],
      },
      { nonDeployable: ['ingest'], root: FIXTURE_ROOT },
    );

    for (const environment of ['local', 'staging', 'production']) {
      const calls = [];
      const runValidator = (_ctx, options) => {
        calls.push(options.app);
        return okValidator();
      };

      auditEnvironments(ctx, {
        environments: [environment],
        withSchema: true,
        decrypt: () => ({ api: { ...clean.api }, web: { ...clean.web } }),
        runValidator,
      });

      expect(calls).toEqual(expect.arrayContaining(['api', 'web']));
      expect(calls.includes('ingest')).toBe(environment === 'local');
    }
  });

  it('always says that the platform is outside what it can see', () => {
    const { notes } = auditEnvironments(fixtureCtx(), {
      environments: ['local'],
      withSchema: false,
      decrypt: () => structuredClone(fixtureClean),
    });

    expect(notes.join(' ')).toMatch(/Vercel or Railway dashboard is invisible/);
  });
});

describe('the package reaches only node builtins', () => {
  it('imports nothing outside node: anywhere under src/', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const foreign = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.mjs$/.test(entry) && !/\.spec\.mjs$/.test(entry)) {
          for (const match of readFileSync(full, 'utf8').matchAll(
            /^import\s[^;]*?from\s+'([^']+)'/gm,
          )) {
            if (!match[1].startsWith('.') && !match[1].startsWith('node:'))
              foreign.push(`${relative(root, full)} -> ${match[1]}`);
          }
        }
      }
    };
    walk(root);
    expect(foreign).toEqual([]);
  });
});
