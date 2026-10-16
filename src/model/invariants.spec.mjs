import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import {
  checkPairs,
  findPlaceholders,
  pairFindings,
  placeholderFindings,
} from './invariants.mjs';

/** A lookup over a plain `{ scope: { key: token } }` fixture. */
const from = (document) => (scope, key) => document[scope]?.[key];

const WEB = 'INTERNAL_API_KEY_WEB';
const ADMIN = 'INTERNAL_API_KEY_ADMIN';
const KEY = 'INTERNAL_API_KEY';

const consistent = {
  api: { [WEB]: 'web-token', [ADMIN]: 'admin-token' },
  web: { [KEY]: 'web-token' },
  admin: { [KEY]: 'admin-token' },
};

const status = (results, name) =>
  results.find((result) => result.name === name).status;

const REGISTRY = {
  shared: [],
  api: [WEB, ADMIN],
  web: [KEY],
  admin: [KEY],
};

/** The three BFF→API pairs, as test data. */
const PAIRS = [
  {
    name: 'api ↔ web',
    left: { scope: 'api', key: WEB },
    right: { scope: 'web', key: KEY },
    relation: 'equal',
    why: 'web presents this key to the API on every BFF call; a mismatch is a blanket 401.',
  },
  {
    name: 'api ↔ admin',
    left: { scope: 'api', key: ADMIN },
    right: { scope: 'admin', key: KEY },
    relation: 'equal',
    why: 'same contract as web, on the admin perimeter.',
  },
  {
    name: 'web ≠ admin',
    left: { scope: 'api', key: WEB },
    right: { scope: 'api', key: ADMIN },
    relation: 'differ',
    why: 'distinct per consumer so a leak in one app cannot mint the other app’s perimeter.',
  },
];

const CTX = registryCtx(REGISTRY, { extra: { pairs: PAIRS } });

describe('the fixture pairs', () => {
  it('explains why each pair exists', () => {
    const { pairs } = fixtureCtx();

    expect(pairs).toHaveLength(1);
    expect(pairs[0].why.length).toBeGreaterThan(20);
  });
});

describe('findPlaceholders', () => {
  it('finds the default placeholders in a document', () => {
    expect(
      findPlaceholders(fixtureCtx(), { api: { A: 'change-me', B: 'real' } }),
    ).toEqual([{ scope: 'api', key: 'A' }]);
  });

  it('honours a configured pattern', () => {
    const ctx = fixtureCtx({ placeholderPattern: /TODO/ });

    expect(
      findPlaceholders(ctx, { api: { A: 'change-me', B: 'TODO' } }),
    ).toEqual([{ scope: 'api', key: 'B' }]);
  });
});

describe('placeholderFindings', () => {
  it('does not name consumer files', () => {
    const [local] = placeholderFindings('local', [{ scope: 'api', key: 'A' }]);
    const [staging] = placeholderFindings('staging', [
      { scope: 'api', key: 'A' },
    ]);

    expect(local.message).toMatch(/deliberate/);
    expect(staging.message).toMatch(/Replace it before/);
  });
});

describe('checkPairs', () => {
  it('passes a consistent environment', () => {
    const results = checkPairs(CTX, from(consistent));

    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('flags a web key that does not match the API side', () => {
    const results = checkPairs(
      CTX,
      from({ ...consistent, web: { [KEY]: 'stale-token' } }),
    );

    expect(status(results, 'api ↔ web')).toBe('violated');
    expect(status(results, 'api ↔ admin')).toBe('ok');
  });

  it('flags an admin key that does not match the API side', () => {
    const results = checkPairs(
      CTX,
      from({ ...consistent, admin: { [KEY]: 'stale-token' } }),
    );

    expect(status(results, 'api ↔ admin')).toBe('violated');
  });

  // This is the one an app's own schema can catch, and only for `api` — the
  // point of keeping it here too is that all three verdicts read together.
  it('flags web and admin sharing one key', () => {
    const results = checkPairs(
      CTX,
      from({
        api: { [WEB]: 'same', [ADMIN]: 'same' },
        web: { [KEY]: 'same' },
        admin: { [KEY]: 'same' },
      }),
    );

    expect(status(results, 'web ≠ admin')).toBe('violated');
  });

  // An unset variable is already reported as `missing-required` or
  // `missing-everywhere`. Calling it a mismatch here would report one problem
  // twice and send the reader looking for a second cause.
  it('reports a pair with a missing side as unknown, not violated', () => {
    const results = checkPairs(
      CTX,
      from({ api: { [WEB]: 'x' }, web: {}, admin: {} }),
    );

    expect(status(results, 'api ↔ web')).toBe('unknown');
    expect(
      results.find((result) => result.name === 'api ↔ web').holds,
    ).toBeNull();
  });

  it('never returns the tokens it compared', () => {
    const results = checkPairs(CTX, from(consistent));

    expect(JSON.stringify(results)).not.toContain('web-token');
    expect(JSON.stringify(results)).not.toContain('admin-token');
  });
});

describe('pairFindings', () => {
  it('says nothing when every pair holds', () => {
    expect(pairFindings('staging', checkPairs(CTX, from(consistent)))).toEqual(
      [],
    );
  });

  it('says nothing for an unknown pair', () => {
    const results = checkPairs(CTX, from({ api: {}, web: {}, admin: {} }));

    expect(pairFindings('staging', results)).toEqual([]);
  });

  it('names the environment, both sides and the consequence', () => {
    const results = checkPairs(
      CTX,
      from({ ...consistent, web: { [KEY]: 'stale-token' } }),
    );
    const [finding] = pairFindings('production', results);

    expect(finding).toMatchObject({
      code: 'pair-mismatch',
      severity: 'error',
      environment: 'production',
    });
    expect(finding.message).toContain('production');
    expect(finding.message).toContain(WEB);
    expect(finding.message).toContain('401');
  });

  it('uses a distinct code for two keys that must differ', () => {
    const results = checkPairs(
      CTX,
      from({
        api: { [WEB]: 'same', [ADMIN]: 'same' },
        web: { [KEY]: 'same' },
        admin: { [KEY]: 'same' },
      }),
    );
    const codes = pairFindings('local', results).map((finding) => finding.code);

    expect(codes).toContain('pair-collision');
  });

  it('never puts a token in a message', () => {
    const results = checkPairs(
      CTX,
      from({ ...consistent, web: { [KEY]: 'stale-token' } }),
    );

    for (const finding of pairFindings('production', results)) {
      expect(finding.message).not.toContain('stale-token');
      expect(finding.message).not.toContain('web-token');
    }
  });
});
