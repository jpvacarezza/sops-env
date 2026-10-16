import { describe, expect, it } from 'vitest';

import {
  assertWritable,
  normalizeStdin,
  parseSetArgs,
  setArgs,
  sopsIndex,
  unsetArgs,
} from './set-plan.mjs';
import { ENVIRONMENTS, SCOPE_KEYS } from './scopes.mjs';

const REGISTRY = {
  shared: [],
  api: ['DATABASE_URL'],
  web: ['TRIPGENCY_API_URL'],
  admin: [],
};

describe('parseSetArgs', () => {
  it('reads environment, scope and key', () => {
    expect(parseSetArgs(['staging', 'api', 'DATABASE_URL'])).toEqual({
      environments: ['staging'],
      scope: 'api',
      key: 'DATABASE_URL',
    });
  });

  it('expands `all` to every environment', () => {
    expect(parseSetArgs(['all', 'api', 'DATABASE_URL']).environments).toEqual(
      ENVIRONMENTS,
    );
  });

  it('names the valid environments when given an unknown one', () => {
    expect(() => parseSetArgs(['prod', 'api', 'DATABASE_URL'])).toThrow(
      /Unknown environment "prod".*local, staging, production.*all/s,
    );
  });

  it('names the valid scopes when given an unknown one', () => {
    expect(() => parseSetArgs(['staging', 'backend', 'DATABASE_URL'])).toThrow(
      /Unknown scope "backend"/,
    );
  });

  // Guessing here writes a real secret to an environment nobody named.
  it('refuses a missing or extra argument, and shows the usage', () => {
    expect(() => parseSetArgs(['staging', 'api'])).toThrow(
      /Expected exactly 3/,
    );
    expect(() => parseSetArgs(['staging', 'api', 'A', 'B'])).toThrow(
      /Expected exactly 3/,
    );
    expect(() => parseSetArgs([])).toThrow(/stdin/);
  });
});

describe('assertWritable', () => {
  it('accepts a key the registry declares for that scope', () => {
    expect(() =>
      assertWritable(
        { scope: 'api', key: 'DATABASE_URL' },
        { registry: REGISTRY },
      ),
    ).not.toThrow();
  });

  // The accident scopes.mjs exists to prevent, and a one-liner makes it easier
  // than the sops CLI does.
  it('refuses a key declared for another scope, and says which', () => {
    expect(() =>
      assertWritable(
        { scope: 'web', key: 'DATABASE_URL' },
        { registry: REGISTRY },
      ),
    ).toThrow(/declared for "api"/);
  });

  it('names the file to edit and says nothing was written', () => {
    expect(() =>
      assertWritable(
        { scope: 'web', key: 'DATABASE_URL' },
        { registry: REGISTRY },
      ),
    ).toThrow(/tools\/secrets\/scopes\.mjs[\s\S]*Nothing was written/);
  });

  it('says so plainly when a key is declared nowhere', () => {
    expect(() =>
      assertWritable({ scope: 'api', key: 'INVENTED' }, { registry: REGISTRY }),
    ).toThrow(/declared for no scope at all/);
  });

  it('refuses a name that is not an environment variable', () => {
    expect(() =>
      assertWritable(
        { scope: 'api', key: 'database_url' },
        { registry: REGISTRY },
      ),
    ).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('refuses an unknown scope', () => {
    expect(() =>
      assertWritable(
        { scope: 'nope', key: 'DATABASE_URL' },
        { registry: REGISTRY },
      ),
    ).toThrow(/Unknown scope/);
  });

  it('defaults to the real registry', () => {
    expect(() =>
      assertWritable({ scope: 'api', key: 'DATABASE_URL' }),
    ).not.toThrow();
    expect(SCOPE_KEYS.api).toContain('DATABASE_URL');
  });
});

describe('sopsIndex', () => {
  it('is the two-level path sops expects', () => {
    expect(sopsIndex('api', 'DATABASE_URL')).toBe('["api"]["DATABASE_URL"]');
  });
});

describe('setArgs', () => {
  it('is argv, not a shell string', () => {
    expect(
      setArgs('secrets/local.enc.yaml', 'web', 'LOG_LEVEL', 'debug'),
    ).toEqual([
      'set',
      'secrets/local.enc.yaml',
      '["web"]["LOG_LEVEL"]',
      '"debug"',
    ]);
  });

  // JSON.stringify is the only correct encoder here: a hand-rolled '"' + v + '"'
  // breaks on every one of these.
  it.each([
    ['an embedded quote', 'a"b'],
    ['a backslash', 'C:\\path\\to'],
    ['a backslash before a quote', '\\"x\\"'],
    ['a newline', 'line1\nline2'],
    ['a CRLF', 'a\r\nb'],
    ['a leading dash', '-rf'],
    ['a percent variable', '%APPDATA%'],
    ['a shell metacharacter salad', 'a^b&c|d$e`f'],
  ])('JSON-encodes %s so it round-trips', (_label, value) => {
    const [, , , encoded] = setArgs('f', 'api', 'K', value);

    expect(JSON.parse(encoded)).toBe(value);
  });

  // A bare number writes type:int, which assertValidDocument rejects — but only
  // at the next check --decrypt or sync, long after the write looked fine.
  it('always writes a string, never a number or a boolean', () => {
    expect(JSON.parse(setArgs('f', 'api', 'PORT', 6003)[3])).toBe('6003');
    expect(JSON.parse(setArgs('f', 'api', 'FLAG', true)[3])).toBe('true');
  });
});

describe('unsetArgs', () => {
  it('is idempotent, so a key already gone is not a failure', () => {
    expect(
      unsetArgs('secrets/local.enc.yaml', 'api', 'VENDOR_DATA_DIR'),
    ).toEqual([
      'unset',
      '--idempotent',
      'secrets/local.enc.yaml',
      '["api"]["VENDOR_DATA_DIR"]',
    ]);
  });
});

describe('normalizeStdin', () => {
  it('strips the newline `echo` adds', () => {
    expect(normalizeStdin('secret\n')).toEqual({
      value: 'secret',
      strippedNewline: true,
    });
  });

  it('strips a CRLF too', () => {
    expect(normalizeStdin('secret\r\n').value).toBe('secret');
  });

  it('leaves a value with no trailing newline alone', () => {
    expect(normalizeStdin('secret')).toEqual({
      value: 'secret',
      strippedNewline: false,
    });
  });

  // Exactly one, so a deliberately multi-line value keeps its shape.
  it('strips only one, and keeps interior newlines', () => {
    expect(normalizeStdin('a\nb\n\n').value).toBe('a\nb\n');
  });

  it('keeps an empty value empty, for the caller to refuse', () => {
    expect(normalizeStdin('\n').value).toBe('');
  });
});
