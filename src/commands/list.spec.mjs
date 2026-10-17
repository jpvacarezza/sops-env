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
import { buildMatrix } from '../model/matrix.mjs';
import {
  FIXTURE_ROOT,
  fixtureCtx,
  registryCtx,
} from '../../test/helpers/ctx.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: [],
  admin: [],
};
const CTX = registryCtx(REGISTRY);
// `collect` asks whether the ciphertext file exists, so it needs a root that has one.
const READ_CTX = registryCtx(REGISTRY, { root: FIXTURE_ROOT });

const CIPHERTEXT = [
  'api:',
  '    DATABASE_URL: ENC[AES256_GCM,data:aaa,iv:i=,tag:t==,type:str]',
  '    LOG_LEVEL: ENC[AES256_GCM,data:bbb,iv:i=,tag:t==,type:str]',
  '',
].join('\n');

const SENTINEL = 'SENTINEL-MUST-NOT-LEAK';

describe('parseListArgs', () => {
  it('defaults to every environment and no decryption', () => {
    expect(parseListArgs(CTX, [])).toEqual({
      environments: CTX.environments,
      withFingerprints: false,
      asJson: false,
      help: false,
    });
  });

  it('reads the flags', () => {
    const options = parseListArgs(CTX, ['--fingerprints', '--json']);

    expect(options.withFingerprints).toBe(true);
    expect(options.asJson).toBe(true);
  });

  it('narrows to the environments named', () => {
    expect(parseListArgs(CTX, ['staging']).environments).toEqual(['staging']);
  });

  it('names the valid flags when given an unknown one', () => {
    expect(() => parseListArgs(CTX, ['--values'])).toThrow(/--fingerprints/);
  });

  // A typo must not silently widen or narrow the view being read.
  it('names the valid environments when given an unknown one', () => {
    expect(() => parseListArgs(CTX, ['prod'])).toThrow(
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
    const { inventories, meta } = collect(READ_CTX, options({ decrypt }));

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
      READ_CTX,
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
      READ_CTX,
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

  // Names only. The grid colours a row from this, and a row cannot be honestly
  // green while an environment holds a REPLACE_ME.
  it('reports which cells hold a placeholder, without the value', () => {
    const decrypt = () => ({
      api: { DATABASE_URL: 'REPLACE_ME', LOG_LEVEL: 'info' },
    });
    const { placeholders } = collect(
      READ_CTX,
      options({ decrypt, withFingerprints: true }),
    );

    expect(placeholders.local).toEqual([{ scope: 'api', key: 'DATABASE_URL' }]);
    expect(JSON.stringify(placeholders)).not.toContain('REPLACE_ME');
  });

  it('reports no placeholders when it was not asked to decrypt', () => {
    expect(collect(READ_CTX, options()).placeholders).toEqual({});
  });

  // These were one flag, and the grid needed the values for its checks. Asking
  // for them handed it fingerprints too, and `renderShell` draws whatever the
  // matrix carries — so every cell showed a fingerprint in a mode nobody had
  // turned on.
  it('reads the values without fingerprinting them', () => {
    const decrypt = () => ({ api: { DATABASE_URL: 'REPLACE_ME' } });
    const { fingerprints, lookups, placeholders, meta } = collect(
      READ_CTX,
      options({ decrypt, withValues: true }),
    );

    expect(fingerprints).toEqual({});
    expect(meta.local.values).toBe('ok');
    expect(lookups.local('api', 'DATABASE_URL')).toBe('REPLACE_ME');
    expect(placeholders.local).toHaveLength(1);
  });

  it('decrypts once for both, when both are asked for', () => {
    let calls = 0;
    const decrypt = () => {
      calls += 1;
      return { api: { DATABASE_URL: 'x' } };
    };
    const { fingerprints } = collect(
      READ_CTX,
      options({ decrypt, withValues: true, withFingerprints: true }),
    );

    expect(calls).toBe(1);
    expect(fingerprints.local.api.DATABASE_URL).toHaveLength(8);
  });

  // No age key for an environment is the normal case for someone who only holds
  // the local one. The grid must stay whole, because presence never needed a key.
  it('degrades to inventory only when a value cannot be decrypted', () => {
    const decrypt = () => {
      throw new Error('no identity matched any of the recipients');
    };
    const { inventories, meta, fingerprints, lookups, placeholders } = collect(
      READ_CTX,
      options({ decrypt, withFingerprints: true }),
    );

    expect(meta.local.values).toBe('unavailable');
    expect(meta.local.valuesError).toMatch(/no identity matched/);
    expect(inventories.local.api.keys.DATABASE_URL).toBeDefined();
    expect(fingerprints.local).toBeUndefined();
    expect(lookups.local).toBeUndefined();
    expect(placeholders.local).toBeUndefined();
  });
});

describe('readDeclarations', () => {
  it('covers every app that has a schema', () => {
    expect(Object.keys(readDeclarations(fixtureCtx()))).toEqual(['api', 'web']);
  });

  it('reads the api schema well enough to tell required from defaulted', () => {
    const api = readDeclarations(fixtureCtx()).api;

    expect(api.DATABASE_URL.presence).toBe('required');
    expect(api.PROXY_HOPS).toEqual({
      presence: 'default',
      defaultLiteral: 'false',
    });
  });
});

describe('render', () => {
  const matrix = buildMatrix(
    registryCtx({ shared: [], api: ['A_REQ'], web: [], admin: [] }),
    {
      environments: ['local', 'staging'],
      inventories: {
        local: { api: { keys: { A_REQ: { line: 2, encrypted: true } } } },
        staging: { api: { keys: {} } },
      },
      declarations: {
        api: { A_REQ: { presence: 'required', defaultLiteral: null } },
      },
    },
  );
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

  it('points an empty scope at the config file', () => {
    expect(text).toContain('(empty on purpose — see secrets.config.mjs)');
  });
});

describe('the list model as JSON', () => {
  it('emits the note in --json rows', () => {
    const ctx = fixtureCtx();
    const matrix = buildMatrix(ctx, {
      environments: ['local'],
      inventories: {},
    });
    const json = JSON.parse(JSON.stringify({ matrix }));

    expect(
      json.matrix.rows.find((row) => row.key === 'SERVICE_KEY_WEB').note,
    ).toMatch(/BFF/);
  });
});
