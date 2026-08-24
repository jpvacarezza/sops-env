import { describe, expect, it } from 'vitest';

import {
  cellMarker,
  collect,
  MARKS,
  parseListArgs,
  readDeclarations,
  render,
  schemaMarker,
} from './list.mjs';
import { buildMatrix } from './matrix.mjs';
import { APP_SCHEMA_FILES } from './env-contract.mjs';
import { ENVIRONMENTS } from './scopes.mjs';

const CIPHERTEXT = [
  'api:',
  '    DATABASE_URL: ENC[AES256_GCM,data:aaa,iv:i=,tag:t==,type:str]',
  '    LOG_LEVEL: ENC[AES256_GCM,data:bbb,iv:i=,tag:t==,type:str]',
  '',
].join('\n');

const SENTINEL = 'SENTINEL-MUST-NOT-LEAK';

describe('parseListArgs', () => {
  it('defaults to every environment and no decryption', () => {
    expect(parseListArgs([])).toEqual({
      environments: ENVIRONMENTS,
      withFingerprints: false,
      asJson: false,
      help: false,
    });
  });

  it('reads the flags', () => {
    const options = parseListArgs(['--fingerprints', '--json']);

    expect(options.withFingerprints).toBe(true);
    expect(options.asJson).toBe(true);
  });

  it('narrows to the environments named', () => {
    expect(parseListArgs(['staging']).environments).toEqual(['staging']);
  });

  it('names the valid flags when given an unknown one', () => {
    expect(() => parseListArgs(['--values'])).toThrow(/--fingerprints/);
  });

  // A typo must not silently widen or narrow the view being read.
  it('names the valid environments when given an unknown one', () => {
    expect(() => parseListArgs(['prod'])).toThrow(
      /Unknown environment "prod".*local, staging, production/s,
    );
  });
});

describe('schemaMarker', () => {
  it('marks a key no schema validates', () => {
    expect(schemaMarker(null)).toBe(MARKS.unvalidated);
  });

  it('marks required and optional', () => {
    expect(schemaMarker({ presence: 'required' })).toBe('req');
    expect(schemaMarker({ presence: 'optional' })).toBe('opt');
  });

  it('shows a short default literal, because it answers the question directly', () => {
    expect(schemaMarker({ presence: 'default', defaultLiteral: '6003' })).toBe(
      'def(6003)',
    );
  });

  // A URL default is longer than the column and half of one is misleading.
  it('elides a long or computed default', () => {
    expect(
      schemaMarker({
        presence: 'default',
        defaultLiteral: "'http://127.0.0.1:6003'",
      }),
    ).toBe('def(…)');
    expect(schemaMarker({ presence: 'default', defaultLiteral: null })).toBe(
      'def(…)',
    );
  });
});

describe('cellMarker', () => {
  it('marks a set value', () => {
    expect(cellMarker({ present: true, encrypted: true }, true)).toBe(
      MARKS.set,
    );
  });

  it('distinguishes declared-but-unset from not-declared-either', () => {
    expect(cellMarker({ present: false }, true)).toBe(MARKS.unset);
    expect(cellMarker({ present: false }, false)).toBe(MARKS.absent);
  });

  it('marks a value that is not encrypted', () => {
    expect(cellMarker({ present: true, encrypted: false }, true)).toBe(
      MARKS.plaintext,
    );
  });
});

describe('collect', () => {
  const options = (extra = {}) => ({
    environments: ['local'],
    readFile: () => CIPHERTEXT,
    ...extra,
  });

  it('reads the inventory without decrypting anything', () => {
    const decrypt = () => {
      throw new Error('must not be called');
    };
    const { inventories, meta } = collect(options({ decrypt }));

    expect(Object.keys(inventories.local.api.keys)).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
    ]);
    expect(meta.local.values).toBe('not-requested');
  });

  // The property that matters. `sync-plan.mjs` keeps values behind a closure for
  // the same reason: a plain object is one JSON.stringify away from a dump.
  it('keeps decrypted values out of everything it returns but the lookup', () => {
    const decrypt = () => ({ api: { DATABASE_URL: SENTINEL } });
    const { inventories, meta, fingerprints, lookups } = collect(
      options({ decrypt, withFingerprints: true }),
    );

    expect(JSON.stringify({ inventories, meta, fingerprints })).not.toContain(
      SENTINEL,
    );
    expect(lookups.local('api', 'DATABASE_URL')).toBe(SENTINEL);
  });

  it('fingerprints equal values equally and unequal values differently', () => {
    const decrypt = () => ({
      api: { DATABASE_URL: 'same', LOG_LEVEL: 'same' },
      web: { OTHER: 'different' },
    });
    const { fingerprints } = collect(
      options({ decrypt, withFingerprints: true, salt: Buffer.from('fixed') }),
    );

    expect(fingerprints.local.api.DATABASE_URL).toBe(
      fingerprints.local.api.LOG_LEVEL,
    );
    expect(fingerprints.local.web.OTHER).not.toBe(
      fingerprints.local.api.DATABASE_URL,
    );
    expect(fingerprints.local.api.DATABASE_URL).toHaveLength(8);
  });

  // No age key for an environment is the normal case for someone who only holds
  // the local one. The grid must stay whole, because presence never needed a key.
  it('degrades to inventory only when a value cannot be decrypted', () => {
    const decrypt = () => {
      throw new Error('no identity matched any of the recipients');
    };
    const { inventories, meta, fingerprints, lookups } = collect(
      options({ decrypt, withFingerprints: true }),
    );

    expect(meta.local.values).toBe('unavailable');
    expect(meta.local.valuesError).toMatch(/no identity matched/);
    expect(inventories.local.api.keys.DATABASE_URL).toBeDefined();
    expect(fingerprints.local).toBeUndefined();
    expect(lookups.local).toBeUndefined();
  });
});

describe('readDeclarations', () => {
  it('covers every app that has a schema', () => {
    expect(Object.keys(readDeclarations())).toEqual(
      Object.keys(APP_SCHEMA_FILES),
    );
  });

  it('reads the api schema well enough to tell required from defaulted', () => {
    const api = readDeclarations().api;

    expect(api.DATABASE_URL.presence).toBe('required');
    expect(api.PORT).toEqual({ presence: 'default', defaultLiteral: '6003' });
  });
});

describe('render', () => {
  const matrix = buildMatrix({
    registry: { shared: [], api: ['A_REQ'], web: [], admin: [] },
    environments: ['local', 'staging'],
    inventories: {
      local: { api: { keys: { A_REQ: { line: 2, encrypted: true } } } },
      staging: { api: { keys: {} } },
    },
    declarations: {
      api: { A_REQ: { presence: 'required', defaultLiteral: null } },
    },
  });
  const lines = render(matrix, {
    meta: {
      local: {
        exists: true,
        recipients: 1,
        lastModified: '2026-08-22T00:00:00Z',
      },
      staging: { exists: true, recipients: 1, lastModified: null },
    },
  });
  const text = lines.join('\n');

  it('lays out one row per variable under its scope', () => {
    expect(text).toContain('api  →  api');
    expect(text).toContain('A_REQ');
  });

  it('shows the schema marker beside the cells, which is what makes ○ readable', () => {
    const line = lines.find((entry) => entry.includes('A_REQ'));

    expect(line).toContain('req');
    expect(line).toContain(MARKS.set);
    expect(line).toContain(MARKS.unset);
  });

  it('reports the missing required key as an error', () => {
    expect(text).toContain('1 error(s)');
    expect(text).toContain('missing-required');
  });

  it('explains the markers, so the grid is readable without the docs', () => {
    expect(text).toContain('req required');
  });

  it('says a file has no stamp rather than printing null', () => {
    expect(text).not.toContain('null');
  });
});
