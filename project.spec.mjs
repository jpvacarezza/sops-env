import { describe, expect, it } from 'vitest';
import { APP_SCOPES, APPS, SCOPES, SCOPE_KEYS } from './scopes.mjs';
import { assertValidDocument, projectEnv } from './project.mjs';

/**
 * A fixture registry, not the real one: these tests pin the projection rules,
 * and pinning them to the live key list would make every added variable a
 * failing test. The real registry gets its own consistency test at the bottom.
 */
const registry = {
  shared: ['SHARED_KEY'],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['SITE_URL', 'LOG_LEVEL'],
  admin: ['SITE_URL'],
};

const doc = {
  shared: { SHARED_KEY: 'shared-value' },
  api: { DATABASE_URL: 'postgresql://localhost/db', LOG_LEVEL: 'debug' },
  web: { SITE_URL: 'https://example.test', LOG_LEVEL: 'info' },
  admin: { SITE_URL: 'https://admin.example.test' },
};

describe('projectEnv', () => {
  it('gives an app the shared scope plus its own', () => {
    expect(projectEnv(doc, 'api', { registry })).toEqual({
      SHARED_KEY: 'shared-value',
      DATABASE_URL: 'postgresql://localhost/db',
      LOG_LEVEL: 'debug',
    });
  });

  it('never projects another app scope', () => {
    const webEnv = projectEnv(doc, 'web', { registry });

    expect(webEnv).not.toHaveProperty('DATABASE_URL');
    expect(webEnv.LOG_LEVEL).toBe('info');
  });

  it('rejects an unknown app', () => {
    expect(() => projectEnv(doc, 'storybook', { registry })).toThrow(
      /unknown app "storybook"/i,
    );
  });

  it('tolerates a scope the document omits entirely', () => {
    expect(
      projectEnv({ shared: { SHARED_KEY: 'x' } }, 'admin', { registry }),
    ).toEqual({
      SHARED_KEY: 'x',
    });
  });
});

describe('assertValidDocument', () => {
  it('accepts the fixture document', () => {
    expect(() => assertValidDocument(doc, { registry })).not.toThrow();
  });

  it('rejects an unknown top-level scope', () => {
    expect(() =>
      assertValidDocument({ ...doc, worker: { X: 'y' } }, { registry }),
    ).toThrow(/unknown scope "worker"/i);
  });

  it('rejects a key that is not in the registry, naming it', () => {
    expect(() =>
      assertValidDocument(
        { ...doc, api: { ...doc.api, DATABSE_URL: 'typo' } },
        { registry },
      ),
    ).toThrow(/DATABSE_URL/);
  });

  it('rejects a key declared in both shared and an app scope', () => {
    expect(() =>
      assertValidDocument(
        {
          ...doc,
          shared: { ...doc.shared, LOG_LEVEL: 'warn' },
          api: doc.api,
        },
        { registry: { ...registry, shared: ['SHARED_KEY', 'LOG_LEVEL'] } },
      ),
    ).toThrow(/LOG_LEVEL/);
  });

  it('allows the same key in two app scopes, because they never merge', () => {
    expect(() => assertValidDocument(doc, { registry })).not.toThrow();
    expect(projectEnv(doc, 'web', { registry }).SITE_URL).toBe(
      'https://example.test',
    );
    expect(projectEnv(doc, 'admin', { registry }).SITE_URL).toBe(
      'https://admin.example.test',
    );
  });

  it('rejects a non-string value, which YAML produces for true/false/numbers', () => {
    expect(() =>
      assertValidDocument(
        { ...doc, web: { ...doc.web, SITE_URL: false } },
        { registry },
      ),
    ).toThrow(/SITE_URL/);
  });
});

describe('the real scope registry', () => {
  it('declares every scope it uses', () => {
    expect(Object.keys(SCOPE_KEYS).sort()).toEqual([...SCOPES].sort());
    for (const app of APPS) {
      expect(APP_SCOPES[app][0]).toBe('shared');
    }
  });

  it('never puts a key in both shared and an app scope', () => {
    const shared = new Set(SCOPE_KEYS.shared);
    for (const app of APPS) {
      for (const key of SCOPE_KEYS[app]) {
        expect(shared.has(key), `${key} is in shared and ${app}`).toBe(false);
      }
    }
  });

  it('keeps vendor credentials out: they live in fetch_credential, not env (ADR-0009, ADR-0035)', () => {
    const allKeys = SCOPES.flatMap((scope) => SCOPE_KEYS[scope]);
    expect(allKeys).not.toContain('TRAVEL_BUDDY_RAPIDAPI_KEY');
    expect(allKeys).not.toContain('TRAVEL_BUDDY_API_HOST');
  });

  it('keeps server-only api secrets out of the web and admin scopes', () => {
    for (const app of ['web', 'admin']) {
      expect(SCOPE_KEYS[app]).not.toContain('DATABASE_URL');
      expect(SCOPE_KEYS[app]).not.toContain('BETTER_AUTH_SECRET');
      expect(SCOPE_KEYS[app]).not.toContain('SECURITY_EVENT_IP_SALT');
    }
  });
});
