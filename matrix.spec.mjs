import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { readDeclarations } from './list.mjs';
import { buildMatrix, receivingApps } from './matrix.mjs';
import { readEnvironment } from './inventory.mjs';
import { secretsFilePath } from './paths.mjs';
import { ENVIRONMENTS, SCOPE_KEYS } from './scopes.mjs';

const REGISTRY = {
  shared: [],
  api: ['A_REQ', 'A_DEF', 'A_OPT'],
  web: [],
  admin: [],
};

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

const build = (inventories, extra = {}) =>
  buildMatrix({
    registry: REGISTRY,
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
    expect(receivingApps('api')).toEqual(['api']);
  });

  it('maps `shared` to every app, because it merges into all of them', () => {
    expect(receivingApps('shared')).toEqual(['api', 'web', 'admin']);
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
      { exemptions: { A_OPT: 'read at point of use' } },
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

// Against the real registry, files and schemas. Deliberately not asserting a
// specific finding: the store is meant to change, and a test pinned to today's
// drift would fail the moment someone fixes it.
describe('the real repository', () => {
  const inventories = Object.fromEntries(
    ENVIRONMENTS.map((environment) => [
      environment,
      readEnvironment(secretsFilePath(environment), { readFile: readFileSync })
        .inventory,
    ]),
  );
  const matrix = buildMatrix({
    registry: SCOPE_KEYS,
    environments: ENVIRONMENTS,
    inventories,
    declarations: readDeclarations(),
  });

  it('has a row for every declared key', () => {
    const declared = Object.entries(SCOPE_KEYS).flatMap(([scope, keys]) =>
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

  it('finds no undeclared and no plaintext key, which secrets:sync also requires', () => {
    expect(matrix.totals.undeclared).toBe(0);
    expect(codes(matrix)).not.toContain('not-encrypted');
  });
});
