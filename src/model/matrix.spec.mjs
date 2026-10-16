import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import { buildMatrix, receivingApps } from './matrix.mjs';
import { readEnvironment } from '../store/inventory.mjs';
import { secretsFilePath } from '../store/paths.mjs';

const REGISTRY = {
  shared: [],
  api: ['A_REQ', 'A_DEF', 'A_OPT'],
  web: [],
  admin: [],
};
const CTX = registryCtx(REGISTRY);

const DECLARATIONS = {
  api: {
    A_REQ: { presence: 'required', defaultLiteral: null },
    A_DEF: { presence: 'default', defaultLiteral: "'x'" },
    A_OPT: { presence: 'optional', defaultLiteral: null },
  },
  web: {},
  admin: {},
};

/** An inventory for one environment: `{ api: ['A_REQ'] }` → the parsed shape. */
const inventory = (scopes, { encrypted = true } = {}) =>
  Object.fromEntries(
    Object.entries(scopes).map(([scope, keys]) => [
      scope,
      {
        keys: Object.fromEntries(
          keys.map((key, index) => [key, { line: index + 1, encrypted }]),
        ),
      },
    ]),
  );

const build = (inventories, extra = {}, ctx = CTX) =>
  buildMatrix(ctx, {
    environments: ['local', 'staging'],
    inventories,
    declarations: DECLARATIONS,
    ...extra,
  });

const codes = (matrix) => matrix.findings.map((finding) => finding.code);

const row = (matrix, scope, key) =>
  matrix.rows.find((entry) => entry.scope === scope && entry.key === key);

describe('receivingApps', () => {
  it('maps an app scope to that app', () => {
    expect(receivingApps(CTX, 'api')).toEqual(['api']);
  });

  it('maps `shared` to every app, because it merges into all of them', () => {
    expect(receivingApps(CTX, 'shared')).toEqual(['api', 'web', 'admin']);
  });
});

describe('buildMatrix rows', () => {
  it('keeps registry order and marks declared keys', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ'] }),
      staging: inventory({ api: ['A_REQ'] }),
    });

    expect(
      matrix.scopes
        .find((group) => group.scope === 'api')
        .rows.map((r) => r.key),
    ).toEqual(['A_REQ', 'A_DEF', 'A_OPT']);
    expect(row(matrix, 'api', 'A_REQ').declared).toBe(true);
  });

  // An undeclared key has to be visible. `assertValidDocument` throws on one,
  // which is the right behaviour for a write path and the wrong one for a
  // viewer: the person looking at the grid is the one who has to fix it.
  it('shows a key nobody declared as a row rather than throwing', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ', 'SNEAKY'] }),
      staging: inventory({ api: ['A_REQ'] }),
    });

    expect(row(matrix, 'api', 'SNEAKY').declared).toBe(false);
    expect(codes(matrix)).toContain('undeclared');
  });

  it('attaches the schema declaration of the owning app', () => {
    const matrix = build({ local: inventory({ api: ['A_DEF'] }), staging: {} });

    expect(row(matrix, 'api', 'A_DEF').schema).toEqual({
      app: 'api',
      presence: 'default',
      defaultLiteral: "'x'",
    });
  });

  it('reports no schema for a key no app validates', () => {
    const matrix = build({
      local: inventory({ api: ['UNVALIDATED'] }),
      staging: {},
    });

    expect(row(matrix, 'api', 'UNVALIDATED').schema).toBeNull();
  });

  it('carries a fingerprint through to the cell when one is given', () => {
    const matrix = build(
      { local: inventory({ api: ['A_REQ'] }), staging: {} },
      { fingerprints: { local: { api: { A_REQ: 'beef' } } } },
    );

    expect(row(matrix, 'api', 'A_REQ').cells.local.fingerprint).toBe('beef');
    expect(row(matrix, 'api', 'A_REQ').cells.staging.fingerprint).toBeNull();
  });
});

describe('buildMatrix findings', () => {
  // The case this whole tool exists for: name parity is green and one
  // environment is missing a variable that has no default.
  it('flags a required key missing from one environment only', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ'] }),
      staging: inventory({ api: [] }),
    });
    const missing = matrix.findings.filter(
      (finding) => finding.code === 'missing-required',
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      severity: 'error',
      environment: 'staging',
      key: 'A_REQ',
    });
  });

  it('says nothing about a defaulted or optional key that is unset', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ'] }),
      staging: inventory({ api: ['A_REQ'] }),
    });

    expect(codes(matrix)).not.toContain('missing-required');
  });

  it('flags a value that is not ENC[', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ'] }, { encrypted: false }),
      staging: inventory({ api: ['A_REQ'] }),
    });

    expect(codes(matrix)).toContain('not-encrypted');
  });

  it('warns once about a key set in no environment', () => {
    const matrix = build({ local: {}, staging: {} });
    const everywhere = matrix.findings.filter(
      (finding) => finding.code === 'missing-everywhere',
    );

    expect(everywhere.map((finding) => finding.key).sort()).toEqual([
      'A_DEF',
      'A_OPT',
    ]);
    expect(everywhere.every((finding) => finding.severity === 'warn')).toBe(
      true,
    );
  });

  // A required key missing everywhere is already one error per environment.
  // Adding "and it is nowhere" sends the reader hunting for a second cause.
  it('does not also warn that a required key is missing everywhere', () => {
    const matrix = build({ local: {}, staging: {} });
    const everywhere = matrix.findings
      .filter((finding) => finding.code === 'missing-everywhere')
      .map((finding) => finding.key);

    expect(everywhere).not.toContain('A_REQ');
    expect(
      matrix.findings.filter((finding) => finding.code === 'missing-required'),
    ).toHaveLength(2);
  });

  it('suppresses that warning for an exempted key', () => {
    const matrix = build(
      { local: {}, staging: {} },
      {},
      registryCtx(REGISTRY, {
        extra: { exemptions: { derived: { A_OPT: 'read at point of use' } } },
      }),
    );

    expect(
      matrix.findings
        .filter((finding) => finding.code === 'missing-everywhere')
        .map((finding) => finding.key),
    ).not.toContain('A_OPT');
  });

  it('counts set, unset and undeclared cells', () => {
    const matrix = build({
      local: inventory({ api: ['A_REQ', 'SNEAKY'] }),
      staging: inventory({ api: ['A_REQ', 'A_DEF'] }),
    });

    expect(matrix.totals).toEqual({ set: 3, unset: 3, undeclared: 1 });
  });

  it('separates error and warning counts', () => {
    const matrix = build({ local: {}, staging: {} });

    // One error per environment for the required key, one warning each for the
    // defaulted and the optional one.
    expect(matrix.counts).toEqual({ error: 2, warn: 2 });
  });
});

it('carries the key note on each row', () => {
  const ctx = fixtureCtx();
  const matrix = buildMatrix(ctx, { environments: ['local'], inventories: {} });
  const noted = matrix.rows.find(
    (r) => r.scope === 'api' && r.key === 'SERVICE_KEY_WEB',
  );

  expect(noted.note).toMatch(/web\.SERVICE_KEY/);
  expect(matrix.rows.find((r) => r.key === 'DATABASE_URL').note).toBeNull();
});

// `ingest` is the real example: an app scope with no Railway service until
// slice 1b, so `DEPLOYABLE_APPS` excludes it while `APPS` still includes it
// (the config). Before the fix, a required key with no default — exactly
// what `ingest.VENDORS_DATABASE_URL` and `ingest.PRODUCT_DATABASE_URL` are —
// produced a `missing-required` error for `staging` and `production` too,
// even though the scope has no platform to be missing FROM there.
describe('buildMatrix and scopes outside DEPLOYABLE_APPS', () => {
  const REGISTRY_WITH_INGEST = {
    ...REGISTRY,
    ingest: ['I_REQ', 'I_DEF'],
  };
  const DECLARATIONS_WITH_INGEST = {
    ...DECLARATIONS,
    ingest: {
      I_REQ: { presence: 'required', defaultLiteral: null },
      I_DEF: { presence: 'default', defaultLiteral: "'x'" },
    },
  };

  const INGEST_CTX = registryCtx(REGISTRY_WITH_INGEST, {
    nonDeployable: ['ingest'],
  });

  const buildAllEnvironments = (inventories) =>
    buildMatrix(INGEST_CTX, {
      environments: INGEST_CTX.environments,
      inventories,
      declarations: DECLARATIONS_WITH_INGEST,
    });

  const ingestFindings = (matrix, code) =>
    matrix.findings.filter(
      (finding) => finding.scope === 'ingest' && finding.code === code,
    );

  it('confirms the fixture scope is outside DEPLOYABLE_APPS', () => {
    expect(INGEST_CTX.deployableApps).not.toContain('ingest');
  });

  it('flags a missing required key in local only, not in staging or production', () => {
    const matrix = buildAllEnvironments({
      local: {},
      staging: {},
      production: {},
    });
    const missing = ingestFindings(matrix, 'missing-required');

    expect(missing.map((finding) => finding.environment)).toEqual(['local']);
    expect(missing[0]).toMatchObject({
      severity: 'error',
      key: 'I_REQ',
    });
  });

  it('does not flag missing-required once local has the key, even though staging and production stay empty', () => {
    const matrix = buildAllEnvironments({
      local: inventory({ ingest: ['I_REQ'] }),
      staging: {},
      production: {},
    });

    expect(ingestFindings(matrix, 'missing-required')).toEqual([]);
  });

  it('still warns missing-everywhere exactly once for a non-required key set nowhere', () => {
    const matrix = buildAllEnvironments({
      local: {},
      staging: {},
      production: {},
    });
    const everywhere = ingestFindings(matrix, 'missing-everywhere');

    expect(everywhere.map((finding) => finding.key)).toEqual(['I_DEF']);
  });

  it('leaves a DEPLOYABLE_APPS scope like api checking every environment', () => {
    const matrix = buildAllEnvironments({
      local: {},
      staging: {},
      production: {},
    });
    const apiMissing = matrix.findings.filter(
      (finding) =>
        finding.scope === 'api' &&
        finding.code === 'missing-required' &&
        finding.key === 'A_REQ',
    );

    expect(apiMissing.map((finding) => finding.environment).sort()).toEqual([
      'local',
      'production',
      'staging',
    ]);
  });
});

// Against the real registry, files and schemas. Deliberately not asserting a
// specific finding: the store is meant to change, and a test pinned to today's
// drift would fail the moment someone fixes it.
describe('the fixture repository', () => {
  const ctx = fixtureCtx();
  const inventories = Object.fromEntries(
    ctx.environments.map((environment) => [
      environment,
      readEnvironment(ctx, secretsFilePath(ctx, environment), {
        readFile: readFileSync,
      }).inventory,
    ]),
  );
  const matrix = buildMatrix(ctx, {
    environments: ctx.environments,
    inventories,
    declarations: {},
  });

  it('has a row for every declared key', () => {
    const declared = Object.entries(ctx.registry).flatMap(([scope, keys]) =>
      keys.map((key) => `${scope}.${key}`),
    );
    const rows = matrix.rows.map((entry) => `${entry.scope}.${entry.key}`);

    for (const key of declared) expect(rows).toContain(key);
  });

  it('emits only codes this module knows how to explain', () => {
    const known = [
      'missing-required',
      'missing-everywhere',
      'undeclared',
      'not-encrypted',
    ];

    for (const finding of matrix.findings) {
      expect(known).toContain(finding.code);
      expect(finding.message.length).toBeGreaterThan(20);
    }
  });

  it('finds no undeclared and no plaintext key, which sops-env sync also requires', () => {
    expect(matrix.totals.undeclared).toBe(0);
    expect(codes(matrix)).not.toContain('not-encrypted');
  });
});
