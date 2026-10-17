import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import {
  exampleFile,
  productionSourceFiles,
  readEnvReads,
  readExampleKeys,
  readSchemaDeclarations,
  readSchemaKeys,
  schemaKeysFile,
} from './env-contract.mjs';

const schema = (document) => JSON.stringify(document);

/**
 * Unit tests for the extractors. A reader that quietly finds nothing turns every
 * assertion downstream into a comparison of two empty sets — green, and worthless.
 */
describe('readSchemaKeys', () => {
  it('reads the names a JSON Schema document declares, in order', () => {
    const source = schema({
      type: 'object',
      properties: {
        PORT: { type: 'string', default: '6003' },
        DATABASE_URL: { type: 'string', minLength: 1 },
        LOG_LEVEL: { type: 'string' },
      },
    });

    expect(readSchemaKeys(source)).toEqual([
      'PORT',
      'DATABASE_URL',
      'LOG_LEVEL',
    ]);
  });

  it('throws rather than reporting an empty schema', () => {
    // The failure mode this guards: a document with no `properties` passes
    // every parity assertion against nothing.
    expect(() => readSchemaKeys(schema({ type: 'object' }))).toThrow(
      /no `properties`/,
    );
    expect(() => readSchemaKeys(schema({ properties: {} }))).toThrow(
      /no `properties`/,
    );
    expect(() => readSchemaKeys(schema({ properties: [] }))).toThrow(
      /no `properties`/,
    );
  });

  it('throws on a document that is not JSON, naming the file kind', () => {
    expect(() => readSchemaKeys('const x = 1;')).toThrow(/not valid JSON/);
  });

  it('refuses a name that is not an environment variable', () => {
    expect(() =>
      readSchemaKeys(schema({ properties: { databaseUrl: {} } })),
    ).toThrow(/"databaseUrl".*UPPER_SNAKE_CASE/);
  });
});

describe('readSchemaDeclarations', () => {
  it('tells required, defaulted and optional apart', () => {
    const source = schema({
      properties: {
        DATABASE_URL: { type: 'string' },
        PORT: { type: 'string', default: '6003' },
        MONITORING_DSN: { type: 'string' },
      },
      required: ['DATABASE_URL'],
    });

    expect(readSchemaDeclarations(source)).toEqual({
      DATABASE_URL: { presence: 'required', defaultLiteral: null },
      PORT: { presence: 'default', defaultLiteral: '6003' },
      MONITORING_DSN: { presence: 'optional', defaultLiteral: null },
    });
  });

  it('reads a variable that is not listed in required as optional', () => {
    const source = schema({ properties: { A: {}, B: {} }, required: ['A'] });

    expect(readSchemaDeclarations(source).B.presence).toBe('optional');
  });

  // A variable with a default is never missing, so listing it in `required`
  // as well must not turn it back into a missing-required error.
  it('lets a default win over required', () => {
    const source = schema({
      properties: { PROXY_HOPS: { default: 'false' } },
      required: ['PROXY_HOPS'],
    });

    expect(readSchemaDeclarations(source).PROXY_HOPS).toEqual({
      presence: 'default',
      defaultLiteral: 'false',
    });
  });

  it('reads an empty-string default, which is not the same as no default', () => {
    const source = schema({
      properties: { ENABLED_COUNTRIES: { default: '' } },
    });

    expect(readSchemaDeclarations(source).ENABLED_COUNTRIES).toEqual({
      presence: 'default',
      defaultLiteral: '',
    });
  });

  it('shows a non-string default as JSON text', () => {
    const source = schema({
      properties: { PORT: { default: 6003 }, ORIGINS: { default: ['a', 'b'] } },
    });
    const declarations = readSchemaDeclarations(source);

    expect(declarations.PORT.defaultLiteral).toBe('6003');
    expect(declarations.ORIGINS.defaultLiteral).toBe('["a","b"]');
  });

  it('throws rather than reporting every variable as unvalidated', () => {
    expect(() => readSchemaDeclarations(schema({ type: 'object' }))).toThrow(
      /no `properties`/,
    );
  });
});

describe('readExampleKeys', () => {
  const example = `
# api runtime env.
NODE_ENV=development

# Optional, has a default.
# VENDOR_DATA_DIR=/mnt/d/vendor-data
NEXT_PUBLIC_GA_MEASUREMENT_ID=
`;

  it('reads only real assignments by default', () => {
    expect(readExampleKeys(example)).toEqual([
      'NODE_ENV',
      'NEXT_PUBLIC_GA_MEASUREMENT_ID',
    ]);
  });

  it('counts a commented assignment as documentation when asked', () => {
    // Documenting an optional variable as a commented line is the convention
    // here — an empty value would be a lie for anything the schema validates.
    expect(readExampleKeys(example, { includeCommented: true })).toEqual([
      'NODE_ENV',
      'VENDOR_DATA_DIR',
      'NEXT_PUBLIC_GA_MEASUREMENT_ID',
    ]);
  });
});

describe('readEnvReads', () => {
  it('finds every process.env read', () => {
    const source = `
const a = process.env.DATABASE_URL;
if (process.env.VERCEL_ENV !== 'production') {}
`;
    expect(readEnvReads(source)).toEqual(['DATABASE_URL', 'VERCEL_ENV']);
  });

  /**
   * Not hypothetical: a JSDoc block explains why `process.env.NEXT_PUBLIC_X`
   * cannot be routed through a parser, and `instrumentation-client.ts` says the
   * same about `process.env.NEXT_PUBLIC_*`. Counting prose would report two
   * variables that do not exist, forever.
   */
  it('ignores reads that appear inside comments', () => {
    const source = `
/**
 * Next only inlines a literal \`process.env.NEXT_PUBLIC_X\` member expression.
 */
// Historical: process.env.OLD_FLAG used to gate this.
const dsn = process.env.NEXT_PUBLIC_MONITORING_DSN;
`;
    expect(readEnvReads(source)).toEqual(['NEXT_PUBLIC_MONITORING_DSN']);
  });

  it('reports each variable once however often it is read', () => {
    const source =
      'process.env.LOG_LEVEL; process.env.LOG_LEVEL; process.env.PORT;';
    expect(readEnvReads(source)).toEqual(['LOG_LEVEL', 'PORT']);
  });
});

describe('productionSourceFiles', () => {
  it('walks the configured roots and skips tests', () => {
    const ctx = fixtureCtx();
    const files = productionSourceFiles(ctx).map((file) => ctx.relative(file));

    expect(files).toEqual(['apps/web/src/uses-env.ts']);
  });

  it('expands a * segment and adds extraFiles that exist', () => {
    const ctx = fixtureCtx({
      contract: {
        sourceRoots: ['apps/*/src'],
        extraFiles: ['apps/*/.env.example', 'apps/*/missing.js'],
      },
    });
    const files = productionSourceFiles(ctx).map((file) => ctx.relative(file));

    expect(files).toContain('apps/api/.env.example');
    expect(files.some((file) => file.endsWith('missing.js'))).toBe(false);
  });
});

describe('schemaKeysFile and exampleFile', () => {
  it('resolve from the app config, and schemaKeysFile is null when unconfigured', () => {
    const ctx = fixtureCtx();
    expect(ctx.relative(schemaKeysFile(ctx, 'api'))).toBe(
      'apps/api/env.schema.json',
    );
    expect(ctx.relative(exampleFile(ctx, 'web'))).toBe('apps/web/.env.example');
    expect(schemaKeysFile(registryCtx({ api: [] }), 'api')).toBeNull();
  });

  it('is null for an app that has a command but no keys file', () => {
    const ctx = fixtureCtx({
      apps: {
        api: { scopes: ['shared', 'api'], schema: { command: ['validate'] } },
        web: { scopes: ['shared', 'web'] },
      },
    });

    expect(schemaKeysFile(ctx, 'api')).toBeNull();
  });
});

describe('the fixture schema keys files', () => {
  // The parity assertion the fixture can make on its own: each keys file names
  // exactly what its app's scopes register, minus what the config exempts.
  it('declare variables the registry knows', () => {
    const ctx = fixtureCtx();

    for (const app of ctx.apps) {
      const source = readFileSync(schemaKeysFile(ctx, app), 'utf8');
      const registered = new Set(
        ctx.appScopes[app].flatMap((s) => ctx.registry[s]),
      );

      for (const key of readSchemaKeys(source)) {
        expect(registered.has(key), `${app}.${key}`).toBe(true);
      }
    }
  });
});

it('reads process.env from the fixture reader and ignores the comment', () => {
  const ctx = fixtureCtx();
  expect(
    readEnvReads(
      readFileSync(join(ctx.root, 'apps/web/src/uses-env.ts'), 'utf8'),
    ),
  ).toEqual(['NEXT_PUBLIC_SITE_URL', 'BUILD_ID']);
});
