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
  schemaFile,
} from './env-contract.mjs';

/**
 * Unit tests for the three extractors. The parity assertions they feed live
 * below; these exist because all three are regexes over source text, and a
 * regex that quietly stops matching turns every assertion downstream into a
 * comparison of two empty sets — green, and worthless.
 */
describe('readSchemaKeys', () => {
  it('reads keys off a zod object, including multi-line entries', () => {
    const source = `
const EnvSchema = z.object({
  PORT: z.coerce.number().default(6003),
  DATABASE_URL: z
    .string()
    .min(1),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});`;
    expect(readSchemaKeys(source)).toEqual([
      'PORT',
      'DATABASE_URL',
      'LOG_LEVEL',
    ]);
  });

  it('throws rather than reporting an empty schema', () => {
    // The failure mode this guards: someone reshapes a schema, the regex stops
    // matching, and every parity assertion passes against nothing.
    expect(() => readSchemaKeys('const x = 1;')).toThrow(/no keys/i);
  });
});

describe('readSchemaDeclarations', () => {
  it('tells required, defaulted and optional apart', () => {
    const source = `
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(6003),
  SENTRY_DSN: z.string().url().optional(),
});`;

    expect(readSchemaDeclarations(source)).toEqual({
      DATABASE_URL: { presence: 'required', defaultLiteral: null },
      PORT: { presence: 'default', defaultLiteral: '6003' },
      SENTRY_DSN: { presence: 'optional', defaultLiteral: null },
    });
  });

  // Several entries describe a default in prose that they do not declare —
  // SWAGGER_ENABLED's JSDoc says "Default false." A reader that counts those
  // marks a required variable as safely defaulted, which is the wrong way round.
  it('does not read a default out of a comment', () => {
    const source = `
const EnvSchema = z.object({
  /** Default false. Production cannot opt in. */
  // .default('nope')
  SWAGGER_ENABLED: z.enum(['true', 'false']),
});`;

    expect(readSchemaDeclarations(source).SWAGGER_ENABLED.presence).toBe(
      'required',
    );
  });

  it('elides a computed default rather than showing half of it', () => {
    const source = `
const EnvSchema = z.object({
  ORIGINS: z.string().default(defaultOrigins()),
});`;

    expect(readSchemaDeclarations(source).ORIGINS).toEqual({
      presence: 'default',
      defaultLiteral: null,
    });
  });

  it('reads an empty-string default, which is not the same as no default', () => {
    const source = `
const EnvSchema = z.object({
  ENABLED_COUNTRIES: z.string().default(''),
});`;

    expect(readSchemaDeclarations(source).ENABLED_COUNTRIES).toEqual({
      presence: 'default',
      defaultLiteral: "''",
    });
  });

  // The last entry is bounded by the object's closing brace, because
  // apps/api/src/config/env.ts chains object-level refinements after it.
  it('does not let the last key absorb a trailing refinement', () => {
    const source = `
const EnvSchema = z
  .object({
    A: z.string(),
    B: z.string(),
  })
  .refine((data) => data.A !== data.B, { message: 'must differ' })
  .refine((data) => Boolean(data.A), { path: ['A'] });`;

    expect(readSchemaDeclarations(source).B).toEqual({
      presence: 'required',
      defaultLiteral: null,
    });
  });

  // The boundary is brace-matched, not "the first line starting with `})`".
  // That shortcut read TRUST_PROXY correctly only because `.default()` came
  // before its `.transform()`; reordering flipped it to `required`, and a
  // defaulted variable then reported as a missing-required error per environment.
  it('finds the default when a transform closes a brace before the object does', () => {
    const source = `
const EnvSchema = z
  .object({
    TRUST_PROXY: z
      .union([z.literal('false'), z.coerce.number()])
      .default('false')
      .transform((value) => {
        return value === 'false' ? false : value;
      }),
  })
  .refine(() => true);`;

    expect(readSchemaDeclarations(source).TRUST_PROXY).toEqual({
      presence: 'default',
      defaultLiteral: "'false'",
    });
  });

  it('still finds it when the transform comes first', () => {
    const source = `
const EnvSchema = z
  .object({
    TRUST_PROXY: z
      .union([z.literal('false'), z.coerce.number()])
      .transform((value) => {
        return value === 'false' ? false : value;
      })
      .default('false'),
  })
  .refine(() => true);`;

    expect(readSchemaDeclarations(source).TRUST_PROXY.presence).toBe('default');
  });

  it('throws rather than reporting every variable as unvalidated', () => {
    expect(() => readSchemaDeclarations('const x = 1;')).toThrow(/no keys/i);
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
   * Not hypothetical: `apps/web/src/env.schema.ts` explains in a JSDoc block
   * why `process.env.NEXT_PUBLIC_X` cannot be routed through a parser, and
   * `instrumentation-client.ts` says the same about `process.env.NEXT_PUBLIC_*`.
   * Counting prose would report two variables that do not exist, forever.
   */
  it('ignores reads that appear inside comments', () => {
    const source = `
/**
 * Next only inlines a literal \`process.env.NEXT_PUBLIC_X\` member expression.
 */
// Historical: process.env.OLD_FLAG used to gate this.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
`;
    expect(readEnvReads(source)).toEqual(['NEXT_PUBLIC_SENTRY_DSN']);
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

    expect(files).toEqual([
      'apps/api/src/env.ts',
      'apps/web/src/env.schema.ts',
      'apps/web/src/uses-env.ts',
    ]);
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

describe('schemaFile and exampleFile', () => {
  it('resolve from the app config, and schemaFile is null when unconfigured', () => {
    const ctx = fixtureCtx();
    expect(ctx.relative(schemaFile(ctx, 'api'))).toBe('apps/api/src/env.ts');
    expect(ctx.relative(exampleFile(ctx, 'web'))).toBe('apps/web/.env.example');
    expect(schemaFile(registryCtx({ api: [] }), 'api')).toBeNull();
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
