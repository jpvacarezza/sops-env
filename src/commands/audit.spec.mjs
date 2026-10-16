import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { APP_SCHEMA_FILES } from '../model/env-contract.mjs';
import {
  ASSUMED_NODE_ENV,
  auditEnvironments,
  childEnvironment,
  findPlaceholders,
  parseAuditArgs,
  placeholderFindings,
  schemaFindings,
  validateProjection,
} from './audit.mjs';
import { ENVIRONMENTS } from '../scopes.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['TRIPGENCY_API_URL'],
  admin: [],
};

const clean = {
  api: { DATABASE_URL: 'postgresql://real/db', LOG_LEVEL: 'info' },
  web: { TRIPGENCY_API_URL: 'https://api.example.com' },
  admin: {},
};

const okValidator = () => ({ status: 0, stdout: '{"ok":true}', stderr: '' });

describe('findPlaceholders', () => {
  it('finds REPLACE_ME and change-me, whatever the case', () => {
    const document = {
      api: { DATABASE_URL: 'postgresql://user:REPLACE_ME@host/db' },
      web: { TRIPGENCY_API_URL: 'http://CHANGE-ME' },
    };

    expect(findPlaceholders(document)).toEqual([
      { scope: 'api', key: 'DATABASE_URL' },
      { scope: 'web', key: 'TRIPGENCY_API_URL' },
    ]);
  });

  it('finds nothing in a provisioned document', () => {
    expect(findPlaceholders(clean)).toEqual([]);
  });

  it('reports one finding per key, however many times the sentinel appears', () => {
    const document = {
      api: { DATABASE_URL: 'postgres://REPLACE_ME:REPLACE_ME@REPLACE_ME/db' },
    };

    expect(findPlaceholders(document)).toHaveLength(1);
  });

  it('ignores a scope that is not a mapping', () => {
    expect(findPlaceholders({ sops: null, api: {} })).toEqual([]);
  });
});

describe('placeholderFindings', () => {
  // secrets/README.md says local holds placeholders on purpose, so calling that
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
      expect(finding.message).toMatch(/STAGING-PROD-CHECKLIST/);
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
    const env = childEnvironment(
      {},
      {
        environment: 'staging',
        base,
        registry: REGISTRY,
      },
    );

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.UNRELATED).toBe('keep me');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('applies the projection', () => {
    const env = childEnvironment(
      { DATABASE_URL: 'postgresql://store/db' },
      { environment: 'staging', base, registry: REGISTRY },
    );

    expect(env.DATABASE_URL).toBe('postgresql://store/db');
  });

  // The store sets NODE_ENV nowhere, so without this every
  // `NODE_ENV === 'production'` refinement is silently disarmed.
  it('assumes the NODE_ENV the platform will set', () => {
    // Literals, not ASSUMED_NODE_ENV: reading the same map on both sides would
    // pass with { production: 'development' }, which disarms every
    // production-only refinement — the one thing this map exists to arm.
    const expected = {
      local: 'development',
      staging: 'staging',
      production: 'production',
    };

    expect(ASSUMED_NODE_ENV).toEqual(expected);
    for (const environment of ENVIRONMENTS) {
      expect(
        childEnvironment({}, { environment, base, registry: REGISTRY })
          .NODE_ENV,
      ).toBe(expected[environment]);
    }
  });

  it('lets a NODE_ENV in the store win over the assumption', () => {
    const env = childEnvironment(
      { NODE_ENV: 'test' },
      { environment: 'production', base, registry: REGISTRY },
    );

    expect(env.NODE_ENV).toBe('test');
  });

  it('maps @tripgency/* to source so nothing has to be built first', () => {
    const env = childEnvironment(
      {},
      {
        environment: 'local',
        base,
        registry: REGISTRY,
      },
    );

    expect(env.NODE_OPTIONS).toContain('--conditions=@org/source');
  });
});

describe('validateProjection', () => {
  const target = { environment: 'staging', app: 'api', document: clean };

  it('passes on a valid verdict', () => {
    expect(
      validateProjection(target, {
        runValidator: okValidator,
        registry: REGISTRY,
      }),
    ).toEqual({ state: 'ok' });
  });

  it('surfaces the schema message on an invalid one', () => {
    const runValidator = () => ({
      status: 1,
      stdout:
        '{"ok":false,"kind":"invalid","message":"  - DATABASE_URL: too short"}',
      stderr: '',
    });

    expect(
      validateProjection(target, { runValidator, registry: REGISTRY }),
    ).toEqual({ state: 'invalid', message: '  - DATABASE_URL: too short' });
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

    expect(
      validateProjection(target, { runValidator, registry: REGISTRY }).state,
    ).toBe('unavailable');
  });

  // A validator that cannot run is not a pass. It is a warning that the check
  // did not happen, which is a different thing from "nothing is wrong".
  it('reports a spawn failure as unavailable, not as ok', () => {
    const runValidator = () => ({ error: new Error('spawn ENOENT') });

    expect(
      validateProjection(target, { runValidator, registry: REGISTRY }).state,
    ).toBe('unavailable');
  });

  it('reports unparseable output as unavailable and keeps the tail of stderr', () => {
    const runValidator = () => ({
      status: 1,
      stdout: '',
      stderr: 'SyntaxError: boom',
    });
    const outcome = validateProjection(target, {
      runValidator,
      registry: REGISTRY,
    });

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
    expect(parseAuditArgs([])).toEqual({
      environments: ENVIRONMENTS,
      withSchema: true,
      help: false,
    });
  });

  it('turns the schema pass off', () => {
    expect(parseAuditArgs(['--no-schema']).withSchema).toBe(false);
  });

  it('names the valid environments when given an unknown one', () => {
    expect(() => parseAuditArgs(['prod'])).toThrow(
      /Unknown environment "prod"/,
    );
  });

  it('refuses an unknown flag', () => {
    expect(() => parseAuditArgs(['--fix'])).toThrow(/Unknown flag "--fix"/);
  });
});

describe('auditEnvironments', () => {
  it('cannot check values it cannot decrypt, and says so rather than passing', () => {
    const decrypt = () => {
      throw new Error('no identity matched any of the recipients');
    };
    const { findings, errors } = auditEnvironments({
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
    const runValidator = (options) => {
      calls.push(options.app);
      return okValidator();
    };
    const decrypt = () => structuredClone(clean);

    auditEnvironments({
      environments: ['staging'],
      withSchema: false,
      decrypt,
      runValidator,
    });
    expect(calls).toEqual([]);

    // `ingest` is outside DEPLOYABLE_APPS, so `staging` is not one of the
    // environments its schema is validated for — see the dedicated test
    // below. This is the per-environment truth now, not the full APPS list.
    auditEnvironments({
      environments: ['staging'],
      withSchema: true,
      decrypt,
      runValidator,
    });
    expect(calls).toEqual(['api', 'web', 'admin']);
  });

  // The same rule `buildMatrix` applies to `missing-required` (matrix.mjs):
  // an app outside DEPLOYABLE_APPS has no platform in `staging` or
  // `production`, so spawning its validator there would only ever report
  // "the projection is empty" — a fact about the store having no platform to
  // fill it from, not about the app's configuration. `local` is real for
  // every app, deployable or not, so it is always validated there.
  it('validates a scope outside DEPLOYABLE_APPS for local only, and a DEPLOYABLE_APPS scope for every environment', () => {
    for (const environment of ['local', 'staging', 'production']) {
      const calls = [];
      const runValidator = (options) => {
        calls.push(options.app);
        return okValidator();
      };

      auditEnvironments({
        environments: [environment],
        withSchema: true,
        decrypt: () => structuredClone(clean),
        runValidator,
      });

      expect(calls).toEqual(expect.arrayContaining(['api', 'web', 'admin']));
      expect(calls.includes('ingest')).toBe(environment === 'local');
    }
  });

  it('always says that the platform is outside what it can see', () => {
    const { notes } = auditEnvironments({
      environments: ['local'],
      withSchema: false,
      decrypt: () => structuredClone(clean),
    });

    expect(notes.join(' ')).toMatch(/Vercel or Railway dashboard is invisible/);
  });
});

// The spawn itself, once, against the real tsx and the real admin schema. Every
// test above injects the validator, so without this the one part that talks to
// another process is unexercised — and that is exactly the shape of bug this
// repo keeps finding: green in tests, broken when it actually runs.
describe('the real validator process', () => {
  const admin = {
    admin: { TRIPGENCY_INTERNAL_API_KEY: 'x'.repeat(32) },
  };

  // tsx has to boot and transpile, which costs well over vitest's 5s default.
  it(
    'accepts a projection its schema is happy with',
    { timeout: 60_000 },
    () => {
      expect(
        validateProjection({
          environment: 'local',
          app: 'admin',
          document: admin,
        }),
      ).toEqual({ state: 'ok' });
    },
  );

  it(
    'reports the schema message for one it is not',
    { timeout: 60_000 },
    () => {
      const outcome = validateProjection({
        environment: 'local',
        app: 'admin',
        document: { admin: { TRIPGENCY_INTERNAL_API_KEY: 'too-short' } },
      });

      expect(outcome.state).toBe('invalid');
      expect(outcome.message).toMatch(/TRIPGENCY_INTERNAL_API_KEY/);
      // Zod 4 names the path and the constraint, never the input. Zod 3 echoed
      // it on enums, so this is pinned rather than assumed.
      expect(outcome.message).not.toContain('too-short');
    },
  );

  // The enum case specifically: that is the one that used to include the
  // received value, and LOG_LEVEL sits in the same projection as real secrets.
  it('does not echo a rejected value back', { timeout: 60_000 }, () => {
    const canary = 'CANARY-must-not-appear';
    const outcome = validateProjection({
      environment: 'local',
      app: 'admin',
      document: {
        admin: {
          TRIPGENCY_INTERNAL_API_KEY: 'x'.repeat(32),
          LOG_LEVEL: canary,
        },
      },
    });

    expect(outcome.state).toBe('invalid');
    expect(outcome.message).toContain('LOG_LEVEL');
    expect(outcome.message).not.toContain(canary);
  });

  // An unknown app never reaches the child process: `projectEnv` rejects it,
  // which is right — that is a caller bug, not a state of the store, and
  // dressing it up as a finding would hide it.
  // The whole "never prints a value" property rests on Zod's own messages, which
  // the canary above pins, and on every `message:` in the three schemas being a
  // fixed string, which this pins. A template literal is the natural way to
  // write the next refinement, and it would put a decrypted production secret
  // through schemaFindings into console.error.
  it('has no schema message that interpolates the value it rejected', () => {
    for (const [app, file] of Object.entries(APP_SCHEMA_FILES)) {
      const interpolated = [
        ...readFileSync(file, 'utf8').matchAll(/message:\s*`[^`]*\$\{/g),
      ].map((match) => match[0]);

      expect(
        interpolated,
        `${app}: a template literal in a schema message can put the rejected value in the audit output`,
      ).toEqual([]);
    }
  });

  it('refuses an unknown app before spawning anything', () => {
    expect(() =>
      validateProjection({ environment: 'local', app: 'nope', document: {} }),
    ).toThrow(/Unknown app "nope"/);
  });
});

// `--no-schema` keeps the audit dependency-free. A third-party import anywhere in
// its module graph would break a consumer that runs it before `pnpm install`.
describe('the audit reaches only node builtins with the schema pass off', () => {
  it('imports nothing outside node: and this package', () => {
    const graph = [
      'commands/audit',
      'commands/list',
      'model/matrix',
      'model/invariants',
      'model/materialized',
      'model/env-contract',
      'store/inventory',
      'store/paths',
      'store/project',
      'store/decrypt',
      'scopes',
    ];
    const foreign = [];
    for (const name of graph) {
      const source = readFileSync(
        new URL(`../${name}.mjs`, import.meta.url),
        'utf8',
      );
      for (const match of source.matchAll(
        /^import\s[^;]*?from\s+'([^']+)'/gm,
      )) {
        const spec = match[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        foreign.push(`${name}.mjs -> ${spec}`);
      }
    }
    expect(foreign).toEqual([]);
  });
});
