# sops-env

SOPS + age secrets for a monorepo. A config file is the registry of which variable belongs to which audience (scope), the ciphertext is one SOPS file per environment, each app gets a projection of the scopes it receives, a navigable grid shows the whole matrix, and `sync` pushes an environment to Vercel and Railway. No npm dependencies. `sops`, `git` and a clipboard tool must be on PATH.

## Install

```sh
pnpm add -D github:jpvacarezza/sops-env#v0.1.0
```

Not published on npm. Requires Node >= 24 and `sops` >= 3.9 with an age key on the machine. `tsx` and `zod` are optional peers: `tsx` runs the Zod schema pass of `audit` (see [Schema validation](#schema-validation)).

## Configure

`secrets.config.mjs` at the repository root, ESM default export. This is the full contract with every default written out; each comment names where the field lived in the original in-repo tool.

```js
/** @type {import('sops-env').SecretsConfig} */
export default {
  store: {
    dir: 'secrets', // paths.mjs
    file: '<environment>.enc.yaml', // `<environment>` placeholder required
    sopsConfig: '.sops.yaml', // init-config.mjs, edit.mjs
    tracked: ['README.md', 'STAGING-PROD-CHECKLIST.md'], // check.mjs TRACKED_SECRETS_FILES
  },
  environments: {
    // scopes.mjs ENVIRONMENTS (order = insertion), audit.mjs ASSUMED_NODE_ENV,
    // sync-plan.mjs SYNCABLE
    local: { nodeEnv: 'development', sync: false },
    staging: { nodeEnv: 'staging', sync: true },
    production: { nodeEnv: 'production', sync: true },
  },
  scopes: {
    // scopes.mjs SCOPES + SCOPE_KEYS; the JSDoc comment above a key becomes its string
    shared: { keys: {} },
    api: {
      keys: {
        DATABASE_URL: null,
        VENDORS_DATABASE_URL:
          'The vendors database, read-only (ADR-0034)…' /* … */,
      },
    },
    web: { keys: {/* … */} },
    admin: { keys: {/* … */} },
    ingest: { keys: {/* … */} },
  },
  apps: {
    // scopes.mjs APPS + APP_SCOPES + DEPLOYABLE_APPS, env-contract.mjs APP_SCHEMA_FILES,
    // paths.mjs appEnvFilePath, validate-projection.ts, sync-plan.mjs destinationFor
    api: {
      scopes: ['shared', 'api'],
      dotenv: 'apps/api/.env.local',
      example: 'apps/api/.env.example',
      schema: { file: 'apps/api/src/config/env.ts', exportName: 'parseApiEnv' },
      destination: {
        provider: 'railway',
        service: {
          staging: 'RAILWAY_SERVICE_ID_API_STAGING',
          production: 'RAILWAY_SERVICE_ID_API_PRODUCTION',
        },
      },
    },
    web: {
      scopes: ['shared', 'web'],
      dotenv: 'apps/web/.env.local',
      example: 'apps/web/.env.example',
      schema: { file: 'apps/web/src/env.schema.ts', exportName: 'parseWebEnv' },
      destination: { provider: 'vercel', project: 'VERCEL_PROJECT_ID_WEB' },
    },
    admin: {/* as web, VERCEL_PROJECT_ID_ADMIN, parseAdminEnv */},
    ingest: {
      scopes: ['shared', 'ingest'],
      dotenv: 'apps/ingest/.env.local',
      example: 'apps/ingest/.env.example',
      schema: {
        file: 'apps/ingest/src/config/env.ts',
        exportName: 'parseIngestEnv',
      },
      destination: null, // not deployable; the DEPLOYABLE_APPS comment moves here
    },
  },
  schemaRunner: { runner: 'tsx', conditions: ['@org/source'], cwd: 'tmp' }, // audit.mjs
  publicPrefixes: ['NEXT_PUBLIC_'], // sync-plan.mjs vercelVarType
  pairs: [
    // invariants.mjs PAIRED_KEYS, verbatim
    {
      name: 'api ↔ web',
      left: { scope: 'api', key: 'TRIPGENCY_INTERNAL_API_KEY_WEB' },
      right: { scope: 'web', key: 'TRIPGENCY_INTERNAL_API_KEY' },
      relation: 'equal',
      why: '…',
    },
    { name: 'api ↔ admin', /* … */ relation: 'equal' },
    { name: 'web ≠ admin', /* … */ relation: 'differ' },
  ],
  exemptions: {
    // scopes.mjs UNPARSED_BY_ZOD, PLATFORM_PROVIDED, DERIVED; list.mjs NOT_DRIFT_WHEN_UNSET is their union
    unparsedBySchema: { VENDOR_DATA_DIR: '…' /* … */ },
    platformProvided: { CI: 'Set by GitHub Actions.' /* … */ },
    derived: { APP_VERSION: '…', NEXT_PUBLIC_WEB_BUILD_ID: '…' },
  },
  placeholderPattern: /REPLACE_ME|change-me/i, // invariants.mjs
  providers: {
    // platform-config.mjs; env-var NAMES only
    vercel: {
      token: 'VERCEL_TOKEN',
      team: 'VERCEL_ORG_ID',
      targets: { staging: ['preview'], production: ['production'] },
    },
    railway: {
      token: 'RAILWAY_TOKEN',
      project: 'RAILWAY_PROJECT_ID',
      environment: {
        staging: 'RAILWAY_ENVIRONMENT_ID_STAGING',
        production: 'RAILWAY_ENVIRONMENT_ID_PRODUCTION',
      },
    },
  },
  contract: {
    // env-contract.mjs productionSourceFiles
    sourceRoots: [
      'apps/*/src',
      'apps/auth-e2e/src',
      'packages/*/src',
      'packages/*/cjs',
    ],
    extraFiles: ['apps/*/next.config.js'],
    ignore: ['node_modules', 'out-tsc'],
  },
};
```

Defaults when a field is absent equal the block above, except: `pairs` is `[]`, every `exemptions` map is empty, `schema` is `null` (audit warns `schema-unchecked`), `destination` is `null`, `schemaRunner.conditions` is `[]`, and `contract.sourceRoots` is `['apps/*/src']`. An app's `dotenv` defaults to `apps/<app>/.env.local` and `example` to `apps/<app>/.env.example`. Required: `apps` (at least one), `scopes` (at least one), and every `apps[*].scopes[]` entry names a declared scope. Resolve-time errors name the field (`apps.web.scopes[1] "shred" is not a declared scope`) and run the shared/app key collision check.

The config holds names only. A key maps to `string | null`: the string is the note naming the key's audience (shown in the grid, emitted by `list --json` as `note`). A note must not start with `age1`, `AGE-SECRET-KEY-` or `ENC[`, and must not contain `=`; the loader rejects it, because a pasted secret is the failure this guards against. The `providers` block holds environment-variable names, never credentials.

Types: `import('sops-env').SecretsConfig`; `defineConfig()` is the identity helper for editor completion.

## Commands

Global options: `--config <file>` picks the config (default: nearest `secrets.config.mjs` above the cwd, or `$SOPS_ENV_CONFIG`); `--help` prints usage, `<command> --help` a command's own. With no command, `sops-env` opens the grid, which needs a terminal. An unknown command exits 2; a missing or invalid config exits 1.

- `sops-env init --<env> <age1...> [--<env> <age1...>] [--force]` writes `.sops.yaml` from age public keys (public only, safe to commit). Exits 1 on a bad key, no environments, or an existing file without `--force`.
- `sops-env edit <env>` opens one environment's ciphertext in `sops`. Exits 1 on an unknown environment.
- `<value on stdin> | sops-env set <env|all> <scope> <KEY> [--sync]` writes one declared variable; the value is read from stdin, never argv. `--sync` dry-runs `sync` for the app the scope feeds, then offers the real one. Exits 1 on error.
- `sops-env unset <env|all> <scope> <KEY>` removes one variable. Takes no value; `--sync` is refused because providers only upsert.
- `sops-env run <env> <app> -- <command...>` decrypts, projects the app's scopes and runs the command with them in its environment. Writes nothing to disk. Exits 1 on setup errors.
- `sops-env materialize <env> <app|all>` writes the app's dotenv file (mode 0600, generated, gitignored). Exits 1 on error.
- `sops-env sync <env> [<app>|all] [--dry-run]` pushes the projection to each app's destination provider. Dry-run prints destination and key names only. Exits 1 on error.
- `sops-env check [--decrypt] [<env>...]` checks the ciphertext structure; with `--decrypt` it also decrypts and projects every app. Exits 1 on a finding.
- `sops-env list [--fingerprints] [--json] [<env>...]` prints the grid as text or JSON. A viewer: it reads, never writes, and exits 0.
- `sops-env audit [--no-schema] [<env>...]` checks values, pairs, placeholders and schemas. Exits non-zero when anything is an error; warnings alone exit 0.

## Providers

A destination names a provider: `destination: { provider: 'vercel' | 'railway' | <inline object> | './path.mjs', ...fields }`. `vercel` and `railway` are built in. A consumer adds one inline in the config, or as a module path (starting `./` or `../`, imported relative to the config file) that exports the same functions. The shape:

```js
/**
 * @typedef {{
 *   name: string,
 *   label: (ctx, { app, environment }) => string,          // 'railway/api'; never a value
 *   resolve: (ctx, { app, environment, env }) => object,   // reads env-var NAMES from ctx, values from env;
 *                                                          // throws `Missing ${NAME}. Set it in the environment …`
 *   upsert: (credentials, { env, keys, ctx }, { fetchImpl }) => Promise<{ destination, keys }>,
 * }} Provider
 */
```

`label` is what `sync --dry-run` prints (`railway/api (staging): 3 keys — …`); it is never a value. The built-ins are exported as `BUILTIN_PROVIDERS` from `sops-env/providers`.

## Schema validation

`audit` can run each app's Zod schema over its projection of each environment, so a store that would fail at boot is an error before it ships.

- `tsx` is resolved from the consumer root (add it as your own devDependency), not from this package.
- When `tsx` is not installed, or the app has no `schema`, the result is `schema-unchecked` (warn), never a verdict about the store.
- `schemaRunner.runner: 'node'` runs JS-only schemas without `tsx`.
- `schemaRunner.conditions` become `--conditions=<name>` in the child's `NODE_OPTIONS`, so workspace packages resolve to sources without a build.
- `schemaRunner.cwd` is where the child runs: `'tmp'` (default, a directory with no `.env` files) or a path relative to the config.
- The child's environment is yours minus every variable the registry knows, plus the projection, with `NODE_ENV` taken from the environment's `nodeEnv`.
- `audit --no-schema` skips the pass.

## Properties

- Values leave a process only as fingerprints or behind a closure; `list`, `check`, `audit` and dry-run print names.
- `set` and `unset` write per cell: three changed lines per edit.
- No runtime dependencies, pinned by a test.

## Developing

```sh
pnpm install && pnpm test
```

Try the CLI on the fixture project with its committed key:

```sh
cd test/fixtures/project
SOPS_AGE_KEY_FILE=../age-key.txt node ../../../bin/sops-env.mjs list
```

The fixture age key is committed on purpose; it protects nothing.

## License

MIT
