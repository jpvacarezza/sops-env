import { describe, expect, it } from 'vitest';

import { checkPairs, PAIRED_KEYS, pairFindings } from './invariants.mjs';
import { SCOPE_KEYS } from './scopes.mjs';

/** A lookup over a plain `{ scope: { key: token } }` fixture. */
const from = (document) => (scope, key) => document[scope]?.[key];

const WEB = 'TRIPGENCY_INTERNAL_API_KEY_WEB';
const ADMIN = 'TRIPGENCY_INTERNAL_API_KEY_ADMIN';
const KEY = 'TRIPGENCY_INTERNAL_API_KEY';

const consistent = {
  api: { [WEB]: 'web-token', [ADMIN]: 'admin-token' },
  web: { [KEY]: 'web-token' },
  admin: { [KEY]: 'admin-token' },
};

const status = (results, name) =>
  results.find((result) => result.name === name).status;

describe('PAIRED_KEYS', () => {
  // A pair naming a key nobody declares can never fire, and would sit here
  // looking like a control forever.
  it('only references keys the registry declares', () => {
    for (const pair of PAIRED_KEYS) {
      for (const side of [pair.left, pair.right]) {
        expect(SCOPE_KEYS[side.scope]).toContain(side.key);
      }
    }
  });

  it('explains why each pair exists', () => {
    for (const pair of PAIRED_KEYS) {
      expect(pair.why.length).toBeGreaterThan(20);
    }
  });
});

describe('checkPairs', () => {
  it('passes a consistent environment', () => {
    const results = checkPairs(from(consistent));

    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('flags a web key that does not match the API side', () => {
    const results = checkPairs(
      from({ ...consistent, web: { [KEY]: 'stale-token' } }),
    );

    expect(status(results, 'api ↔ web')).toBe('violated');
    expect(status(results, 'api ↔ admin')).toBe('ok');
  });

  it('flags an admin key that does not match the API side', () => {
    const results = checkPairs(
      from({ ...consistent, admin: { [KEY]: 'stale-token' } }),
    );

    expect(status(results, 'api ↔ admin')).toBe('violated');
  });

  // This is the one an app's own schema can catch, and only for `api` — the
  // point of keeping it here too is that all three verdicts read together.
  it('flags web and admin sharing one key', () => {
    const results = checkPairs(
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
      from({ api: { [WEB]: 'x' }, web: {}, admin: {} }),
    );

    expect(status(results, 'api ↔ web')).toBe('unknown');
    expect(
      results.find((result) => result.name === 'api ↔ web').holds,
    ).toBeNull();
  });

  it('never returns the tokens it compared', () => {
    const results = checkPairs(from(consistent));

    expect(JSON.stringify(results)).not.toContain('web-token');
    expect(JSON.stringify(results)).not.toContain('admin-token');
  });
});

describe('pairFindings', () => {
  it('says nothing when every pair holds', () => {
    expect(pairFindings('staging', checkPairs(from(consistent)))).toEqual([]);
  });

  it('says nothing for an unknown pair', () => {
    const results = checkPairs(from({ api: {}, web: {}, admin: {} }));

    expect(pairFindings('staging', results)).toEqual([]);
  });

  it('names the environment, both sides and the consequence', () => {
    const results = checkPairs(
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
      from({ ...consistent, web: { [KEY]: 'stale-token' } }),
    );

    for (const finding of pairFindings('production', results)) {
      expect(finding.message).not.toContain('stale-token');
      expect(finding.message).not.toContain('web-token');
    }
  });
});
