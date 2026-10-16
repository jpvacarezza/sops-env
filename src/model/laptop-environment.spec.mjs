/**
 * The environment that never syncs is whatever the config says has `sync:
 * false`, not the literal name `local`. A consumer with `development` /
 * `production` gets the same treatment `local` / `staging` / `production` does.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURE_ROOT, registryCtx } from '../../test/helpers/ctx.mjs';
import { auditEnvironments } from '../commands/audit.mjs';
import { placeholderFindings } from './invariants.mjs';
import { materializedFindings } from './materialized.mjs';
import { buildMatrix } from './matrix.mjs';

const ENVIRONMENTS = {
  development: { nodeEnv: 'development', sync: false },
  production: { nodeEnv: 'production', sync: true },
};

const REGISTRY = {
  shared: ['LOG_LEVEL'],
  api: ['DATABASE_URL'],
  ingest: ['I_REQ'],
};

const ctxAt = (root = '/repo') =>
  registryCtx(REGISTRY, {
    environments: Object.keys(ENVIRONMENTS),
    nonDeployable: ['ingest'],
    root,
    extra: { environments: ENVIRONMENTS },
  });

const CTX = ctxAt();

describe('an environment with sync: false that is not named local', () => {
  it('is the only one not syncable', () => {
    expect(CTX.syncable).toEqual(['production']);
  });

  it('makes a placeholder a warning there and an error elsewhere', () => {
    const at = (environment) =>
      placeholderFindings(CTX, environment, [{ scope: 'api', key: 'A' }])[0];

    expect(at('development').severity).toBe('warn');
    expect(at('development').message).toMatch(/deliberate/);
    expect(at('production').severity).toBe('error');
  });

  it('is where materialized dotenv files are checked', () => {
    const inventory = { api: { keys: { DATABASE_URL: { line: 2 } } } };
    const options = (environment) => ({
      environment,
      inventory,
      apps: ['api'],
      exists: () => false,
      readFile: () => '',
    });

    expect(
      materializedFindings(CTX, options('development')).map((f) => f.code),
    ).toEqual(['not-materialized']);
    expect(materializedFindings(CTX, options('production'))).toEqual([]);
  });

  it('is the one environment a non-deployable scope is held to', () => {
    const matrix = buildMatrix(CTX, {
      environments: CTX.environments,
      inventories: { development: {}, production: {} },
      declarations: {
        ingest: { I_REQ: { presence: 'required', defaultLiteral: null } },
      },
    });
    const missing = matrix.findings.filter(
      (finding) =>
        finding.scope === 'ingest' && finding.code === 'missing-required',
    );

    expect(missing.map((finding) => finding.environment)).toEqual([
      'development',
    ]);
  });

  it('is where audit validates a non-deployable app', () => {
    const root = mkdtempSync(join(tmpdir(), 'sops-env-laptop-'));
    mkdirSync(join(root, 'secrets'));
    for (const [to, from] of [
      ['development', 'local'],
      ['production', 'production'],
    ])
      copyFileSync(
        join(FIXTURE_ROOT, 'secrets', `${from}.enc.yaml`),
        join(root, 'secrets', `${to}.enc.yaml`),
      );
    const ctx = ctxAt(root);

    for (const environment of ctx.environments) {
      const calls = [];
      auditEnvironments(ctx, {
        environments: [environment],
        decrypt: () => ({ shared: {}, api: {}, ingest: {} }),
        runValidator: (_ctx, { app }) => {
          calls.push(app);
          return { status: 0, stdout: '{"ok":true}', stderr: '' };
        },
      });

      expect(calls.includes('ingest')).toBe(environment === 'development');
      expect(calls).toContain('api');
    }
  });
});
