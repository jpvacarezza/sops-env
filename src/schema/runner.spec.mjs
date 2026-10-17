import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import {
  COULD_NOT_RUN,
  childEnvironment,
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

const okValidator = () => ({ status: 0, stdout: '', stderr: '' });

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

  // The language-neutral twin of NODE_ENV: an app that has no use for NODE_ENV
  // still has to know which environment it is being validated against.
  it('names the environment for validators that are not Node apps', () => {
    for (const environment of CTX.environments) {
      expect(
        childEnvironment(CTX, {}, { environment, base }).SOPS_ENVIRONMENT,
      ).toBe(environment);
    }
  });

  it('does not touch NODE_OPTIONS', () => {
    const env = childEnvironment(
      CTX,
      {},
      {
        environment: 'local',
        base: { ...base, NODE_OPTIONS: '--no-warnings' },
      },
    );

    expect(env.NODE_OPTIONS).toBe('--no-warnings');
    expect(
      childEnvironment(CTX, {}, { environment: 'local', base }).NODE_OPTIONS,
    ).toBeUndefined();
  });
});

describe('validateProjection', () => {
  const target = { environment: 'staging', app: 'api', document: clean };

  it('passes on exit status 0', () => {
    expect(
      validateProjection(CTX, target, { runValidator: okValidator }),
    ).toEqual({ state: 'ok' });
  });

  it('surfaces what the command printed on any other status', () => {
    const runValidator = () => ({
      status: 1,
      stdout: '',
      stderr: '  - DATABASE_URL: too short\n',
    });

    expect(validateProjection(CTX, target, { runValidator })).toEqual({
      state: 'invalid',
      message: '- DATABASE_URL: too short',
    });
  });

  it('falls back to stdout when stderr is empty', () => {
    const runValidator = () => ({
      status: 2,
      stdout: 'DATABASE_URL: required',
      stderr: '',
    });

    expect(validateProjection(CTX, target, { runValidator })).toEqual({
      state: 'invalid',
      message: 'DATABASE_URL: required',
    });
  });

  it('still reports a verdict when the command printed nothing', () => {
    const runValidator = () => ({ status: 3, stdout: '', stderr: '' });

    expect(validateProjection(CTX, target, { runValidator })).toEqual({
      state: 'invalid',
      message: 'exited with status 3',
    });
  });

  // A validator that could not load its own subject has said nothing about the
  // store. Calling that `invalid` reads as "production's config is wrong" when
  // the truth is "this tool is broken", and someone would go looking at Railway.
  it('reports the could-not-run status as unavailable, not invalid', () => {
    const runValidator = () => ({
      status: COULD_NOT_RUN,
      stdout: '',
      stderr: 'ModuleNotFoundError: No module named "api"',
    });

    expect(validateProjection(CTX, target, { runValidator })).toEqual({
      state: 'unavailable',
      message: 'ModuleNotFoundError: No module named "api"',
    });
  });

  // A validator that cannot run is not a pass. It is a warning that the check
  // did not happen, which is a different thing from "nothing is wrong".
  it('reports a spawn failure as unavailable, not as ok', () => {
    const runValidator = () => ({ error: new Error('spawn EACCES') });

    expect(validateProjection(CTX, target, { runValidator }).state).toBe(
      'unavailable',
    );
  });

  it('reports a command killed by a signal or a timeout as unavailable', () => {
    const runValidator = () => ({ status: null, signal: 'SIGTERM' });
    const outcome = validateProjection(CTX, target, { runValidator });

    expect(outcome.state).toBe('unavailable');
    expect(outcome.message).toMatch(/SIGTERM/);
  });

  it('reports a command that does not exist as missing, not as unchecked', () => {
    const ctx = fixtureCtx({
      apps: {
        api: {
          scopes: ['shared', 'api'],
          schema: { command: ['no-such-validator'] },
        },
        web: { scopes: ['shared', 'web'] },
      },
    });
    const runValidator = () => ({
      error: Object.assign(new Error('spawn no-such-validator ENOENT'), {
        code: 'ENOENT',
      }),
    });

    expect(
      validateProjection(
        ctx,
        { environment: 'staging', app: 'api', document: { api: {} } },
        { runValidator },
      ),
    ).toEqual({
      state: 'missing',
      message: 'apps.api.schema.command "no-such-validator" was not found',
    });
  });

  // ADR-0002. A validator that quotes the value it rejected (pydantic does)
  // must not put that value in an audit report.
  it('redacts every projected value out of what the command printed', () => {
    const runValidator = () => ({
      status: 1,
      stdout: '',
      stderr: 'DATABASE_URL: invalid, input_value=postgresql://real/db',
    });
    const outcome = validateProjection(CTX, target, { runValidator });

    expect(outcome.message).toBe(
      'DATABASE_URL: invalid, input_value=<redacted>',
    );
    expect(outcome.message).not.toContain('postgresql://real/db');
  });

  it('redacts the message of a could-not-run status as well', () => {
    const runValidator = () => ({
      status: COULD_NOT_RUN,
      stdout: '',
      stderr: 'cannot connect to postgresql://real/db',
    });

    expect(
      validateProjection(CTX, target, { runValidator }).message,
    ).not.toContain('postgresql://real/db');
  });

  it('caps what it reports', () => {
    const runValidator = () => ({
      status: 1,
      stdout: '',
      stderr: 'x'.repeat(5000),
    });

    expect(
      validateProjection(CTX, target, { runValidator }).message.length,
    ).toBeLessThan(600);
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

  it('is an error when the command is missing', () => {
    const [finding] = schemaFindings('production', 'api', {
      state: 'missing',
      message: 'apps.api.schema.command "x" was not found',
    });

    expect(finding).toMatchObject({
      code: 'schema-missing',
      severity: 'error',
      scope: 'api',
      environment: 'production',
    });
    expect(finding.message).toMatch(/Fix the command in secrets\.config\.mjs/);
  });
});

describe('runnerCommand', () => {
  it('splits the configured argv into a program and its arguments', () => {
    const ctx = fixtureCtx();
    const { command, args } = runnerCommand(ctx, { app: 'api' });

    expect(command).toBe(process.execPath);
    expect(args).toEqual([join(ctx.root, 'apps/api/validate-env.mjs')]);
  });

  // The default exists so a loader that reads dotenv from the working
  // directory cannot add variables the store does not have.
  it('runs from the OS temp directory unless told otherwise', () => {
    const ctx = fixtureCtx();

    expect(runnerCommand(ctx, { app: 'api' }).cwd).not.toBe(ctx.root);
  });

  it('resolves a configured cwd against the config root', () => {
    const ctx = fixtureCtx({
      apps: {
        api: {
          scopes: ['shared', 'api'],
          schema: { command: ['validate'], cwd: 'apps/api' },
        },
        web: { scopes: ['shared', 'web'] },
      },
    });

    expect(runnerCommand(ctx, { app: 'api' }).cwd).toBe(
      join(ctx.root, 'apps/api'),
    );
  });

  it('is unavailable, not an error, when the app has no schema', () => {
    expect(runnerCommand(registryCtx({ api: [] }), { app: 'api' })).toEqual({
      unavailable:
        'apps.api.schema.command is not configured in secrets.config.mjs',
    });
  });

  it('is unavailable when the app declares keys but no command', () => {
    const ctx = fixtureCtx({
      apps: {
        api: {
          scopes: ['shared', 'api'],
          schema: { keys: 'apps/api/env.schema.json' },
        },
        web: { scopes: ['shared', 'web'] },
      },
    });

    expect(runnerCommand(ctx, { app: 'api' })).toEqual({
      unavailable:
        'apps.api.schema.command is not configured in secrets.config.mjs',
    });
  });
});

// The spawn itself. Every test above injects the validator; without these the
// one part that talks to another process is unexercised. The commands are
// `node` only because CI has nothing else guaranteed: the runner reads an exit
// status and two streams and cannot tell what language wrote them.
describe('the real validator process', { timeout: 60_000 }, () => {
  const ctx = fixtureCtx();
  const good = {
    shared: { LOG_LEVEL: 'info' },
    api: {
      DATABASE_URL: 'postgresql://x/y',
      SERVICE_KEY_WEB: 'k'.repeat(32),
    },
    web: {},
  };

  /** The fixture's api app with a different command. */
  const withCommand = (command) =>
    fixtureCtx({
      apps: {
        api: { scopes: ['shared', 'api'], schema: { command } },
        web: { scopes: ['shared', 'web'] },
      },
    });
  const node = (script, ...args) => [process.execPath, '-e', script, ...args];
  const run = (ctx_, document = good) =>
    validateProjection(ctx_, {
      environment: 'local',
      app: 'api',
      document,
    });

  it('accepts a projection its validator is happy with', () => {
    expect(run(ctx)).toEqual({ state: 'ok' });
  });

  it('reports the validator message for one it is not, without echoing the value', () => {
    const outcome = run(ctx, {
      ...good,
      api: { ...good.api, SERVICE_KEY_WEB: 'too-short' },
    });

    expect(outcome.state).toBe('invalid');
    expect(outcome.message).toMatch(/SERVICE_KEY_WEB/);
    expect(outcome.message).not.toContain('too-short');
  });

  it('fires the cross-variable check', () => {
    const same = 'same-value-same-value-same-value-1234';
    const outcome = run(ctx, {
      ...good,
      api: { DATABASE_URL: same, SERVICE_KEY_WEB: same },
    });

    expect(outcome).toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/must not equal DATABASE_URL/),
    });
  });

  it('hands the command the projection and the environment name', () => {
    const script =
      'process.exit(process.env.SOPS_ENVIRONMENT === "local" && process.env.DATABASE_URL === "postgresql://x/y" ? 0 : 3)';

    expect(run(withCommand(node(script)))).toEqual({ state: 'ok' });
  });

  it('does not let a variable from the parent shell satisfy the store', () => {
    process.env.DATABASE_URL = 'postgresql://from-my-shell/db';
    try {
      const script =
        'process.exit(process.env.DATABASE_URL === undefined ? 0 : 3)';

      expect(run(withCommand(node(script)), { api: {} })).toEqual({
        state: 'ok',
      });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  // The command is an argv, never a shell line: an argument with spaces and
  // metacharacters arrives as one string.
  it('passes arguments verbatim, with no shell in between', () => {
    const script = 'process.exit(process.argv[1] === "a b;c && d" ? 0 : 3)';

    expect(run(withCommand(node(script, 'a b;c && d')))).toEqual({
      state: 'ok',
    });
  });

  it('does not echo a value the validator itself quoted', () => {
    const script =
      'console.error("rejected " + process.env.DATABASE_URL); process.exit(1)';
    const outcome = run(withCommand(node(script)));

    expect(outcome.state).toBe('invalid');
    expect(outcome.message).toBe('rejected <redacted>');
  });

  it('reads the could-not-run status as unavailable', () => {
    expect(run(withCommand(node(`process.exit(${COULD_NOT_RUN})`))).state).toBe(
      'unavailable',
    );
  });

  it('reports a command that does not exist as missing', () => {
    const outcome = run(withCommand(['sops-env-no-such-validator-xyz']));

    expect(outcome.state).toBe('missing');
    expect(outcome.message).toMatch(/sops-env-no-such-validator-xyz/);
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
