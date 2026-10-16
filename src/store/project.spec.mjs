import { describe, expect, it } from 'vitest';
import { registryCtx } from '../../test/helpers/ctx.mjs';
import { assertValidDocument, projectEnv } from './project.mjs';

/**
 * A fixture registry: these tests pin the projection rules, and pinning them to
 * a live key list would make every added variable a failing test. The
 * shared-vs-app collision rule is owned by the config resolver.
 */
const registry = {
  shared: ['SHARED_KEY'],
  api: ['DATABASE_URL', 'LOG_LEVEL'],
  web: ['SITE_URL', 'LOG_LEVEL'],
  admin: ['SITE_URL'],
};
const ctx = registryCtx(registry);

const doc = {
  shared: { SHARED_KEY: 'shared-value' },
  api: { DATABASE_URL: 'postgresql://localhost/db', LOG_LEVEL: 'debug' },
  web: { SITE_URL: 'https://example.test', LOG_LEVEL: 'info' },
  admin: { SITE_URL: 'https://admin.example.test' },
};

describe('projectEnv', () => {
  it('gives an app the shared scope plus its own', () => {
    expect(projectEnv(ctx, doc, 'api')).toEqual({
      SHARED_KEY: 'shared-value',
      DATABASE_URL: 'postgresql://localhost/db',
      LOG_LEVEL: 'debug',
    });
  });

  it('never projects another app scope', () => {
    const webEnv = projectEnv(ctx, doc, 'web');

    expect(webEnv).not.toHaveProperty('DATABASE_URL');
    expect(webEnv.LOG_LEVEL).toBe('info');
  });

  it('rejects an unknown app', () => {
    expect(() => projectEnv(ctx, doc, 'storybook')).toThrow(
      /unknown app "storybook"/i,
    );
  });

  it('tolerates a scope the document omits entirely', () => {
    expect(projectEnv(ctx, { shared: { SHARED_KEY: 'x' } }, 'admin')).toEqual({
      SHARED_KEY: 'x',
    });
  });
});

describe('assertValidDocument', () => {
  it('accepts the fixture document', () => {
    expect(() => assertValidDocument(ctx, doc)).not.toThrow();
  });

  it('rejects an unknown top-level scope', () => {
    expect(() =>
      assertValidDocument(ctx, { ...doc, worker: { X: 'y' } }),
    ).toThrow(/unknown scope "worker"/i);
  });

  it('rejects a key that is not in the registry, naming it', () => {
    expect(() =>
      assertValidDocument(ctx, {
        ...doc,
        api: { ...doc.api, DATABSE_URL: 'typo' },
      }),
    ).toThrow(/DATABSE_URL/);
  });

  it('names secrets.config.mjs for an undeclared key', () => {
    expect(() =>
      assertValidDocument(registryCtx({ shared: [], api: [] }), {
        api: { NOPE: 'x' },
      }),
    ).toThrow(/"NOPE" is not declared for scope "api" in secrets\.config\.mjs/);
  });

  it('allows the same key in two app scopes, because they never merge', () => {
    expect(() => assertValidDocument(ctx, doc)).not.toThrow();
    expect(projectEnv(ctx, doc, 'web').SITE_URL).toBe('https://example.test');
    expect(projectEnv(ctx, doc, 'admin').SITE_URL).toBe(
      'https://admin.example.test',
    );
  });

  it('rejects a non-string value, which YAML produces for true/false/numbers', () => {
    expect(() =>
      assertValidDocument(ctx, {
        ...doc,
        web: { ...doc.web, SITE_URL: false },
      }),
    ).toThrow(/SITE_URL/);
  });
});
