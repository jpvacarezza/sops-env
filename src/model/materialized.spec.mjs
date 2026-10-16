import { describe, expect, it } from 'vitest';

import { registryCtx } from '../../test/helpers/ctx.mjs';
import { materializedFindings, storeKeysForApp } from './materialized.mjs';

const CTX = registryCtx({ shared: [], api: [], admin: [] });

/** Shape `inventory.mjs` produces: scope → keys → { line, encrypted }. */
const inventory = (scopes) =>
  Object.fromEntries(
    Object.entries(scopes).map(([scope, keys]) => [
      scope,
      {
        keys: Object.fromEntries(
          keys.map((key, index) => [key, { line: index + 2, encrypted: true }]),
        ),
      },
    ]),
  );

const API_STORE = inventory({
  api: [
    'DATABASE_URL',
    'BETTER_AUTH_URL',
    'BETTER_AUTH_URL_ADMIN',
    'MONITORING_DSN',
  ],
});

const DECLARATIONS = {
  api: {
    DATABASE_URL: { presence: 'required' },
    BETTER_AUTH_URL: { presence: 'required' },
    BETTER_AUTH_URL_ADMIN: { presence: 'required' },
    MONITORING_DSN: { presence: 'optional' },
  },
};

/** One app, one file, so a case reads as the disk it describes. */
const onDisk = (text) => ({
  exists: () => text !== null,
  readFile: () => text,
});

const findingsFor = (text, { environment = 'local' } = {}) =>
  materializedFindings(CTX, {
    environment,
    inventory: API_STORE,
    declarations: DECLARATIONS,
    apps: ['api'],
    ...onDisk(text),
  });

describe('storeKeysForApp', () => {
  it('merges shared into an app scope, without duplicating', () => {
    const merged = storeKeysForApp(
      CTX,
      'api',
      inventory({ shared: ['LOG_LEVEL'], api: ['DATABASE_URL', 'LOG_LEVEL'] }),
    );

    expect(merged).toEqual(['LOG_LEVEL', 'DATABASE_URL']);
  });

  it('is empty for an app the store says nothing about', () => {
    expect(storeKeysForApp(CTX, 'admin', API_STORE)).toEqual([]);
  });
});

describe('materializedFindings', () => {
  /**
   * The case this file exists for. Every other check was green while this was
   * true: the store had the variable, the schema required it, and the generated
   * file predated both.
   */
  it('is an error when a required key is in the store and not on disk', () => {
    const findings = findingsFor(
      [
        'DATABASE_URL="postgresql://user:pw@127.0.0.1:5432/db"',
        'BETTER_AUTH_URL="http://localhost:6001"',
        'MONITORING_DSN=""',
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'stale-materialized',
      severity: 'error',
      scope: 'api',
      key: 'BETTER_AUTH_URL_ADMIN',
    });
    expect(findings[0].message).toContain('sops-env materialize local api');
  });

  it('downgrades a key the schema does not require to a warning', () => {
    const findings = findingsFor(
      [
        'DATABASE_URL="postgresql://user:pw@127.0.0.1:5432/db"',
        'BETTER_AUTH_URL="http://localhost:6001"',
        'BETTER_AUTH_URL_ADMIN="http://localhost:6002"',
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'drifted-materialized',
      severity: 'warn',
      key: 'MONITORING_DSN',
    });
  });

  it('reports a key on disk the store no longer declares', () => {
    // README's case: regenerating is the only thing that removes it, so a
    // retired variable can keep a dead code path alive on one laptop.
    const findings = findingsFor(
      [
        'DATABASE_URL="postgresql://user:pw@127.0.0.1:5432/db"',
        'BETTER_AUTH_URL="http://localhost:6001"',
        'BETTER_AUTH_URL_ADMIN="http://localhost:6002"',
        'MONITORING_DSN=""',
        'TRAVEL_BUDDY_API_KEY="retired"',
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'orphaned-materialized',
      severity: 'warn',
      key: 'TRAVEL_BUDDY_API_KEY',
    });
  });

  it('says nothing when the file matches the store', () => {
    expect(
      findingsFor(
        [
          'DATABASE_URL="postgresql://user:pw@127.0.0.1:5432/db"',
          'BETTER_AUTH_URL="http://localhost:6001"',
          'BETTER_AUTH_URL_ADMIN="http://localhost:6002"',
          'MONITORING_DSN=""',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('reports the whole file once, rather than key by key', () => {
    const findings = findingsFor(null);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'not-materialized',
      severity: 'error',
      key: null,
    });
  });

  it('is silent for staging and production, which have no file on disk', () => {
    // They reach their platform through `sops-env sync`. Reporting a missing
    // file there would put two permanent errors in front of every reader until
    // they learned to skip the section.
    for (const environment of ['staging', 'production']) {
      expect(findingsFor(null, { environment })).toEqual([]);
    }
  });

  it('reads no value, only names', () => {
    const findings = findingsFor(
      'DATABASE_URL="postgresql://user:SENTINEL-MUST-NOT-LEAK@h/db"',
    );

    expect(JSON.stringify(findings)).not.toContain('SENTINEL-MUST-NOT-LEAK');
  });
});
