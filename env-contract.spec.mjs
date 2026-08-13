import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  APP_SCHEMA_FILES,
  appExampleFile,
  productionSourceFiles,
  readEnvReads,
  readExampleKeys,
  readSchemaKeys,
} from './env-contract.mjs';
import {
  APPS,
  APP_SCOPES,
  DERIVED,
  PLATFORM_PROVIDED,
  SCOPE_KEYS,
  UNPARSED_BY_ZOD,
} from './scopes.mjs';

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

describe('readExampleKeys', () => {
  const example = `
# @tripgency/api runtime env.
NODE_ENV=development

# Optional, has a default.
# VENDOR_DATA_DIR=/mnt/d/tripgency-data
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

/**
 * Against the real files, not a fixture. A regex over source is exactly the
 * kind of thing that keeps passing its fixture after the source it targets has
 * moved on — the same reason `apps/api/src/architecture/env-port.spec.ts`
 * reads the real `config/env.ts`.
 */
describe('the extractors still match the real files', () => {
  for (const [app, file] of Object.entries(APP_SCHEMA_FILES)) {
    it(`${app}: finds keys in ${file.split(/[\\/]/).slice(-2).join('/')}`, () => {
      expect(readSchemaKeys(readFileSync(file, 'utf8')).length).toBeGreaterThan(
        0,
      );
    });
  }
});

/**
 * The contract itself: schema ⟷ .env.example ⟷ scopes.mjs ⟷ the code.
 *
 * This replaces `registry-coverage.spec.mjs`, which checked exactly one of the
 * four directions — `.env.example ⊆ registry` — and so stayed green while the
 * other three drifted. Assertion 6 is the one with no equivalent there at all:
 * `NOAA_GHCND_CHUNK_ROWS` shipped in a variable no list contained, which no
 * amount of comparing those three lists to each other could have caught.
 */
const readExample = (app, options) =>
  readExampleKeys(readFileSync(appExampleFile(app), 'utf8'), options);

const missing = (from, allowed) => from.filter((key) => !allowed.has(key));

describe('env contract', () => {
  for (const app of APPS) {
    describe(app, () => {
      const schema = readSchemaKeys(
        readFileSync(APP_SCHEMA_FILES[app], 'utf8'),
      );
      const registry = APP_SCOPES[app].flatMap((scope) => SCOPE_KEYS[scope]);
      // Commented entries count as documentation everywhere except assertion 3,
      // whose subject is the projection: a commented line ships nothing.
      const documented = new Set(readExample(app, { includeCommented: true }));
      const assigned = readExample(app);

      it('validates nothing the projection would never send', () => {
        expect(
          missing(schema, new Set(registry)),
          'add these to tools/secrets/scopes.mjs',
        ).toEqual([]);
      });

      it('documents every variable it validates', () => {
        expect(
          missing(schema, documented),
          `add these to apps/${app}/.env.example`,
        ).toEqual([]);
      });

      it('declares nothing the projection would drop', () => {
        expect(
          missing(assigned, new Set(registry)),
          'add these to tools/secrets/scopes.mjs',
        ).toEqual([]);
      });

      it('documents every variable the projection sends', () => {
        expect(
          missing(registry, documented),
          `add these to apps/${app}/.env.example (a commented # KEY= counts)`,
        ).toEqual([]);
      });

      it('gives a written reason for anything Zod does not validate', () => {
        const unparsed = missing(registry, new Set(schema));
        expect(
          missing(unparsed, new Set(Object.keys(UNPARSED_BY_ZOD))),
          'add these to UNPARSED_BY_ZOD in tools/secrets/scopes.mjs, with the reason',
        ).toEqual([]);
      });
    });
  }

  it('knows about every variable the code actually reads', () => {
    const declared = new Set([
      ...Object.values(SCOPE_KEYS).flat(),
      ...Object.keys(PLATFORM_PROVIDED),
      ...Object.keys(DERIVED),
    ]);

    const undeclared = [];
    for (const file of productionSourceFiles()) {
      for (const key of readEnvReads(readFileSync(file, 'utf8'))) {
        if (!declared.has(key)) undeclared.push(`${key} (${file})`);
      }
    }

    expect(
      undeclared,
      'a variable is read but appears in no list: add it to a scope in ' +
        'tools/secrets/scopes.mjs and to the app .env.example, or — if the ' +
        'platform sets it or the build derives it — to PLATFORM_PROVIDED / DERIVED',
    ).toEqual([]);
  });
});
