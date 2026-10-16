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
  findPlaceholders,
  parseAuditArgs,
  placeholderFindings,
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

  it('reports schema-unchecked, not schema-invalid, when the apps have no schema', () => {
    // The fixture ciphertext exists on disk (auditEnvironments reads inventories
    // from it); the override drops both schema entries.
    const ctx = fixtureCtx({
      apps: {
        api: { scopes: ['shared', 'api'] },
        web: { scopes: ['shared', 'web'] },
      },
    });
    const { findings, errors } = auditEnvironments(ctx, {
      environments: ['local'],
      decrypt: () => ({ shared: {}, api: { DATABASE_URL: 'x' }, web: {} }),
    });

    expect(findings.filter((f) => f.code === 'schema-unchecked')).toHaveLength(
      2,
    );
    expect(errors.map((f) => f.code)).not.toContain('schema-invalid');
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
