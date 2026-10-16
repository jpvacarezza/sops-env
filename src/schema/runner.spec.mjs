import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { schemaFile } from '../model/env-contract.mjs';
import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import {
  childEnvironment,
  defaultRunValidator,
  runnerCommand,
  schemaFindings,
  validateProjection,
} from './runner.mjs';

const CTX = registryCtx({
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['API_URL'],
  admin: [],
});

const clean = {
  api: { DATABASE_URL: 'postgresql://real/db', LOG_LEVEL: 'info' },
  web: { API_URL: 'https://api.example.com' },
  admin: {},
};

const okValidator = () => ({ status: 0, stdout: '{"ok":true}', stderr: '' });

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

describe('runnerCommand', () => {
  it('spawns node with tsx/cli, the .ts validator, the schema module and the export', () => {
    const ctx = fixtureCtx();
    const { command, args, cwd } = runnerCommand(ctx, { app: 'api' });

    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/[\\/]tsx[\\/]/);
    expect(args[1]).toMatch(/validate-projection\.ts$/);
    expect(args[2]).toBe(join(ctx.root, 'apps/api/src/env.ts'));
    expect(args[3]).toBe('parseApiEnv');
    expect(cwd).not.toBe(ctx.root);
  });

  it('uses the .mjs twin without tsx for runner: node', () => {
    const ctx = fixtureCtx({ schemaRunner: { runner: 'node', cwd: '.' } });
    const { args, cwd } = runnerCommand(ctx, { app: 'web' });

    expect(args[0]).toMatch(/validate-projection\.mjs$/);
    expect(args).toHaveLength(3);
    expect(cwd).toBe(ctx.root);
  });

  it('is unavailable, not an error, when the app has no schema', () => {
    expect(runnerCommand(registryCtx({ api: [] }), { app: 'api' })).toEqual({
      unavailable: 'apps.api.schema is not configured in secrets.config.mjs',
    });
  });

  // Review Focus 3: tsx missing from the consumer root is a warning, never schema-invalid.
  it('is unavailable when tsx cannot be resolved from the consumer root', () => {
    const ctx = fixtureCtx();
    const resolveFrom = () => {
      throw Object.assign(new Error("Cannot find module 'tsx/cli'"), {
        code: 'MODULE_NOT_FOUND',
      });
    };

    expect(runnerCommand(ctx, { app: 'api' }, { resolveFrom })).toEqual({
      unavailable: expect.stringMatching(
        /tsx is not installed .*schemaRunner\.runner/,
      ),
    });
    expect(
      validateProjection(
        ctx,
        { environment: 'local', app: 'api', document: { api: {} } },
        {
          runValidator: (c, target) =>
            defaultRunValidator(c, target, { resolveFrom }),
        },
      ),
    ).toEqual({
      state: 'unavailable',
      message: expect.stringMatching(/tsx is not installed/),
    });
  });
});

// The spawn itself, against the real tsx and the fixture schemas. Every other
// test injects the validator; without these the one part that talks to another
// process is unexercised.
describe('the real validator process', { timeout: 60_000 }, () => {
  const ctx = fixtureCtx();
  const good = {
    shared: { LOG_LEVEL: 'info' },
    api: {
      DATABASE_URL: 'postgresql://x/y',
      INTERNAL_API_KEY_WEB: 'k'.repeat(32),
    },
    web: {},
  };

  it('accepts a projection its schema is happy with', () => {
    expect(
      validateProjection(ctx, {
        environment: 'local',
        app: 'api',
        document: good,
      }),
    ).toEqual({ state: 'ok' });
  });

  it('reports the schema message for one it is not, without echoing the value', () => {
    const outcome = validateProjection(ctx, {
      environment: 'local',
      app: 'api',
      document: {
        ...good,
        api: { ...good.api, INTERNAL_API_KEY_WEB: 'too-short' },
      },
    });

    expect(outcome.state).toBe('invalid');
    expect(outcome.message).toMatch(/INTERNAL_API_KEY_WEB/);
    expect(outcome.message).not.toContain('too-short');
  });

  it('does not echo a rejected enum value back', () => {
    const canary = 'CANARY-must-not-appear';
    const outcome = validateProjection(ctx, {
      environment: 'local',
      app: 'web',
      document: {
        shared: { LOG_LEVEL: canary },
        api: {},
        web: { API_URL: 'https://a.test', INTERNAL_API_KEY: 'k'.repeat(32) },
      },
    });

    expect(outcome.state).toBe('invalid');
    expect(outcome.message).toContain('LOG_LEVEL');
    expect(outcome.message).not.toContain(canary);
  });

  it('fires the object-level refine', () => {
    const same = 'same-value-same-value-same-value-1234';
    const outcome = validateProjection(ctx, {
      environment: 'local',
      app: 'api',
      document: {
        ...good,
        api: { DATABASE_URL: same, INTERNAL_API_KEY_WEB: same },
      },
    });

    expect(outcome).toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/must not equal DATABASE_URL/),
    });
  });

  it('reports a missing export as unavailable, not invalid', () => {
    const wrong = fixtureCtx({
      apps: {
        api: {
          scopes: ['shared', 'api'],
          schema: { file: 'apps/api/src/env.ts', exportName: 'parseNope' },
        },
        web: { scopes: ['shared', 'web'] },
      },
    });

    expect(
      validateProjection(wrong, {
        environment: 'local',
        app: 'api',
        document: good,
      }),
    ).toMatchObject({
      state: 'unavailable',
      message: expect.stringMatching(/exports no "parseNope"/),
    });
  });

  it('runs the .mjs twin for runner: node against a JS schema', () => {
    // No zod needed for the twin's contract: any module exporting a parser works.
    const js = fixtureCtx({
      schemaRunner: { runner: 'node' },
      apps: {
        api: {
          scopes: ['shared', 'api'],
          schema: { file: 'apps/api/src/env-plain.mjs', exportName: 'parse' },
        },
        web: { scopes: ['shared', 'web'] },
      },
    });
    expect(
      validateProjection(js, {
        environment: 'local',
        app: 'api',
        document: good,
      }),
    ).toEqual({ state: 'ok' });
  });

  it('has no schema message that interpolates the value it rejected', () => {
    for (const app of ctx.apps) {
      const source = readFileSync(schemaFile(ctx, app), 'utf8');
      expect([...source.matchAll(/message:\s*`[^`]*\$\{/g)], app).toEqual([]);
    }
  });

  it('refuses an unknown app before spawning anything', () => {
    expect(() =>
      validateProjection(ctx, {
        environment: 'local',
        app: 'nope',
        document: {},
      }),
    ).toThrow(/Unknown app "nope"/);
  });
});
