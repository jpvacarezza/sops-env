/**
 * Extractors for the env-var contract.
 *
 * The same list of variables lives in four places: each app's schema keys file
 * (a JSON Schema document), its `.env.example`, the scope registry in
 * `secrets.config.mjs`, and the code that reads `process.env`.
 * `env-contract.spec.mjs` compares them; this file is only the reading.
 *
 * The schema keys file is a manifest of names, parsed with `JSON.parse`. It says
 * which variables an app declares and whether each is required, defaulted or
 * optional. It never judges a value: that is the app's own validator command,
 * run by `schema/runner.mjs`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path of the app's schema keys file, or null when it declares none. */
export function schemaKeysFile(ctx, app) {
  const keys = ctx.app[app]?.schema?.keys;
  return keys ? resolve(ctx.root, keys) : null;
}

/** That app's `.env.example`, the documented contract. */
export function exampleFile(ctx, app) {
  return resolve(ctx.root, ctx.app[app].example);
}

/**
 * Expand one root pattern. Only `*` as a whole path segment is supported
 * (`apps/*\/src`): that is the shape a monorepo needs, and a full glob library
 * would be the package's first dependency.
 */
function expandPattern(root, pattern) {
  let paths = [root];
  for (const segment of pattern.split('/')) {
    paths = paths.flatMap((base) => {
      if (segment !== '*') return [join(base, segment)];
      if (!existsSync(base)) return [];
      return readdirSync(base)
        .filter((entry) => statSync(join(base, entry)).isDirectory())
        .map((entry) => join(base, entry));
    });
  }
  return paths;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The `properties` of a JSON Schema document, validated.
 *
 * Throws on an empty or malformed document, because an empty set would make
 * every parity assertion downstream compare nothing and pass.
 */
function schemaProperties(source) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `The schema keys file is not valid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }

  const properties = document?.properties;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Object.keys(properties).length === 0
  ) {
    throw new Error(
      'The schema keys file declares no `properties`. Every presence marker ' +
        'downstream would read as "not validated" and no grid cell would look wrong.',
    );
  }

  for (const key of Object.keys(properties)) {
    if (!NAME.test(key)) {
      throw new Error(
        `The schema keys file declares ${JSON.stringify(key)}, which is not an environment variable name (UPPER_SNAKE_CASE).`,
      );
    }
  }

  return { properties, required: new Set(document.required ?? []) };
}

/** Variable names declared by a JSON Schema document, in declaration order. */
export function readSchemaKeys(source) {
  return Object.keys(schemaProperties(source).properties);
}

/**
 * How each declared variable is declared: `required`, `default`, or `optional`.
 *
 * A property with a `default` is `default` even when it is also listed in
 * `required`: a variable with a default is never missing. `defaultLiteral` is
 * the default as text, or `null` when there is none.
 *
 * This is presence only, and presence is not semantics. A constraint that
 * depends on another variable, or on the environment, is invisible here.
 * Running the app's own validator over the real projection is the only way to
 * check those, which is what `sops-env audit` does.
 */
export function readSchemaDeclarations(source) {
  const { properties, required } = schemaProperties(source);

  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => {
      if (
        property !== null &&
        typeof property === 'object' &&
        'default' in property
      ) {
        const value = property.default;
        return [
          key,
          {
            presence: 'default',
            defaultLiteral:
              typeof value === 'string' ? value : JSON.stringify(value),
          },
        ];
      }
      return [
        key,
        {
          presence: required.has(key) ? 'required' : 'optional',
          defaultLiteral: null,
        },
      ];
    }),
  );
}

/**
 * Keys documented in a `.env.example`.
 *
 * `includeCommented: false` (the default) reads only real assignments, which is
 * what the projection contract means: a commented line ships nothing. Pass
 * `true` to also count `# KEY=`, which is how an optional variable is
 * documented here — `VENDOR_DATA_DIR` and `MONITORING_DSN` both have defaults, and
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
 * a pattern this repo uses; the cost of not stripping is permanent false
 * positives from JSDoc that explains why `NEXT_PUBLIC_*` bypasses validation.
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
 * Every module whose `process.env` reads are part of the contract: the
 * configured source roots, minus tests, plus whichever `extraFiles` exist.
 *
 * Walks the tree rather than shelling out to `git ls-files`, so this behaves
 * the same in a tarball as in a clone.
 */
export function productionSourceFiles(ctx) {
  const roots = ctx.contract.sourceRoots.flatMap((pattern) =>
    expandPattern(ctx.root, pattern),
  );
  const files = roots.flatMap((root) => [...walk(root)]);

  for (const pattern of ctx.contract.extraFiles) {
    for (const candidate of expandPattern(ctx.root, pattern)) {
      if (existsSync(candidate) && statSync(candidate).isFile())
        files.push(candidate);
    }
  }

  const ignored = new RegExp(
    `[\\\\/](${ctx.contract.ignore.join('|')})[\\\\/]`,
  );
  return ctx.contract.ignore.length > 0
    ? files.filter((file) => !ignored.test(file))
    : files;
}

/** Distinct `process.env.X` reads in a module, in first-seen order. */
export function readEnvReads(source) {
  const matches = [
    ...stripComments(source).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
  ].map((match) => match[1]);

  return [...new Set(matches)];
}
