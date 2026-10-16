/**
 * Extractors for the env-var contract.
 *
 * The same list of variables lives in four places: each app's Zod schema, its
 * `.env.example`, the scope registry in `scopes.mjs`, and the code that reads
 * `process.env`. `env-contract.spec.mjs` compares them; this file is only the
 * reading.
 *
 * Everything here parses source text with a regex rather than importing it,
 * for reasons specific to the files involved: `apps/api/src/config/env.ts`
 * calls `loadEnvConfig()` at import time, so importing it would demand a valid
 * environment and run dotenv; and its `EnvSchema` is wrapped in `.refine()`,
 * which does not expose `.shape`. `apps/api/src/architecture/env-port.spec.ts`
 * reads `config/env.ts` as text for the same reason.
 *
 * The price of a regex is that it can silently stop matching, so
 * `readSchemaKeys` throws on an empty result and the spec re-runs all three
 * against the real files.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WORKSPACE_ROOT } from './paths.mjs';
import { APPS } from './scopes.mjs';

/** Where each app declares the variables it validates. */
export const APP_SCHEMA_FILES = {
  api: join(WORKSPACE_ROOT, 'apps/api/src/config/env.ts'),
  web: join(WORKSPACE_ROOT, 'apps/web/src/env.schema.ts'),
  admin: join(WORKSPACE_ROOT, 'apps/admin/src/env.schema.ts'),
  ingest: join(WORKSPACE_ROOT, 'apps/ingest/src/config/env.ts'),
};

/** That app's `.env.example`, the documented contract (technical spec §18). */
export function appExampleFile(app) {
  return join(WORKSPACE_ROOT, 'apps', app, '.env.example');
}

/**
 * Keys declared in a Zod object literal.
 *
 * Matches `KEY: z` and nothing else, which covers the multi-line entries too
 * (`DATABASE_URL: z\n  .string()`): every entry in all three schemas begins
 * with `z`.
 */
export function readSchemaKeys(source) {
  const keys = [...source.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*z\b/gm)].map(
    (match) => match[1],
  );

  if (keys.length === 0) {
    throw new Error(
      'readSchemaKeys found no keys. The schema was reshaped and this regex no ' +
        'longer matches it — every parity assertion downstream would now be ' +
        'comparing empty sets and passing. Fix the pattern, do not delete this check.',
    );
  }

  return keys;
}

/**
 * Offset where the enclosing `z.object({ … })` literal closes.
 *
 * Brace-matched, not "the first line that starts with `})`". That shortcut gave
 * the right answer only by accident: in `apps/api/src/config/env.ts` the first
 * such line closes `TRUST_PROXY`'s own `.transform()`, and it landed after the
 * `.default('false')` this needs to see. Reorder that entry to
 * `.transform(…).default('false')` and the shortcut cuts the default off, which
 * would flip `TRUST_PROXY` to `required` and make `buildMatrix` emit a
 * `missing-required` error per environment for a variable that has a default.
 *
 * A brace inside a string literal would still throw the count off. No schema
 * message contains one, and the spec runs this against all three real files, so
 * that stays a known limit rather than a guess.
 */
function objectEnd(code, from) {
  let depth = 1;

  for (let index = from; index < code.length; index += 1) {
    const character = code[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return code.length;
}

/**
 * The argument of the first `.default(...)`: the literal, or `null` when it is
 * computed, or `undefined` when there is no default at all.
 *
 * Three states rather than two because "defaulted to something I cannot render
 * in a grid cell" and "not defaulted" mean opposite things to a reader deciding
 * whether an unset variable is a problem.
 */
function defaultLiteral(body) {
  const at = body.search(/\.default\s*\(/);
  if (at === -1) return undefined;

  const open = body.indexOf('(', at);
  let depth = 0;
  for (let index = open; index < body.length; index += 1) {
    if (body[index] === '(') depth += 1;
    else if (body[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        const inner = body.slice(open + 1, index).trim();
        return /[(){}[\]]/.test(inner) ? null : inner;
      }
    }
  }

  return null;
}

function declarationFrom(body) {
  const literal = defaultLiteral(body);
  if (literal !== undefined) {
    return { presence: 'default', defaultLiteral: literal };
  }

  return {
    presence: /\.(optional|nullish)\s*\(/.test(body) ? 'optional' : 'required',
    defaultLiteral: null,
  };
}

/**
 * How each schema entry is declared: `required`, `default`, or `optional`.
 *
 * Uses the same `KEY: z` pattern as `readSchemaKeys`, so the two agree about
 * which keys exist for every input that matters — the difference is that this
 * one strips comments first, so a commented-out entry inside a `/* … *\/` block
 * would be found by `readSchemaKeys` and not by this. `env-contract.spec.mjs`
 * asserts they agree on all three real files, which is the check that counts.
 *
 * Comments are stripped because several entries describe a default in prose
 * (`SWAGGER_ENABLED`: "Default false.") that they do not declare, and one that
 * does declare one describes it too.
 *
 * The last entry is bounded by the object literal's closing `})`, not by
 * end-of-file: `apps/api/src/config/env.ts` chains object-level `.refine()`
 * calls after the object, and the last key would otherwise absorb them.
 *
 * This is presence only, and presence is not semantics. `TRUST_PROXY` reads as
 * a `default` and is really a union collapsed to boolean|number;
 * `ENABLED_COUNTRIES` reads as a default of `''` and is really a validated
 * ISO-3166 list; `GOOGLE_CLIENT_ID` reads as `optional` and is required in
 * production by an object-level refinement no source scan can evaluate. Running
 * the real schema over the real projection is the only way to check those —
 * which is what `secrets:audit` does.
 */
export function readSchemaDeclarations(source) {
  const code = stripComments(source);
  const heads = [...code.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*z\b/gm)];

  if (heads.length === 0) {
    throw new Error(
      'readSchemaDeclarations found no keys. The schema was reshaped and this ' +
        'regex no longer matches it — every presence marker downstream would ' +
        'read as "not validated" and no grid cell would look wrong. Fix the ' +
        'pattern, do not delete this check.',
    );
  }

  const declarations = {};

  heads.forEach((head, index) => {
    const start = head.index + head[0].length;
    const next = heads[index + 1];
    const end = next ? next.index : objectEnd(code, start);
    declarations[head[1]] = declarationFrom(code.slice(start, end));
  });

  return declarations;
}

/**
 * Keys documented in a `.env.example`.
 *
 * `includeCommented: false` (the default) reads only real assignments, which is
 * what the projection contract means: a commented line ships nothing. Pass
 * `true` to also count `# KEY=`, which is how an optional variable is
 * documented here — `VENDOR_DATA_DIR` and `SENTRY_DSN` both have defaults, and
 * writing them as empty assignments would state something untrue.
 */
export function readExampleKeys(source, { includeCommented = false } = {}) {
  const pattern = includeCommented
    ? /^#?\s*([A-Z][A-Z0-9_]*)=/gm
    : /^([A-Z][A-Z0-9_]*)=/gm;

  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Strips comments so prose about `process.env` is not read as a use of it.
 *
 * Deliberately crude — it is a lint over our own source, not a JS parser. The
 * cost of over-stripping is a missed read inside a string literal, which is not
 * a pattern this repo uses; the cost of not stripping is two permanent false
 * positives from the JSDoc that explains why `NEXT_PUBLIC_*` bypasses the Zod
 * schemas.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCE_EXTENSIONS = /\.(m|c)?(j|t)sx?$/;
const TEST_FILE = /\.(spec|itest|test)\.(m|c)?(j|t)sx?$/;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXTENSIONS.test(entry) && !TEST_FILE.test(entry)) {
      yield full;
    }
  }
}

/**
 * Every module whose `process.env` reads are part of the contract.
 *
 * `apps/auth-e2e` is inside the net on purpose: it boots the real API and reads
 * the API's own variables, so a variable added there is the same debt as one
 * added anywhere else. Tests are excluded because a test may legitimately
 * fabricate an environment to assert against.
 *
 * Walks the tree rather than shelling out to `git ls-files`, so this behaves
 * the same in a tarball as in a clone.
 */
export function productionSourceFiles() {
  const packagesDir = join(WORKSPACE_ROOT, 'packages');
  const packageRoots = readdirSync(packagesDir).flatMap((name) => [
    join(packagesDir, name, 'src'),
    // `cjs/` is not a build artefact here: `next-config.cjs` is hand-written
    // and is where SENTRY_AUTH_TOKEN is read.
    join(packagesDir, name, 'cjs'),
  ]);

  // Named subdirectories rather than walking `apps/` and `packages/` whole.
  // A blanket walk picks up build output that happens to sit in the tree —
  // `packages/ui/storybook-static/` reads NODE_DEBUG — and no denylist of
  // artefact directory names stays complete.
  const roots = [
    ...APPS.map((app) => join(WORKSPACE_ROOT, 'apps', app, 'src')),
    join(WORKSPACE_ROOT, 'apps/auth-e2e/src'),
    ...packageRoots,
  ];

  const files = roots.flatMap((root) => [...walk(root)]);

  // Next config is not under `src/` and is exactly where build-time variables
  // are read — `NEXT_PUBLIC_WEB_BUILD_ID` is assigned in one.
  for (const app of APPS) {
    const config = join(WORKSPACE_ROOT, 'apps', app, 'next.config.js');
    if (existsSync(config)) files.push(config);
  }

  return files.filter((file) => !/[\\/](node_modules|out-tsc)[\\/]/.test(file));
}

/** Distinct `process.env.X` reads in a module, in first-seen order. */
export function readEnvReads(source) {
  const matches = [
    ...stripComments(source).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
  ].map((match) => match[1]);

  return [...new Set(matches)];
}
