# sops-env

SOPS + age secrets for a monorepo. A config file is the registry of which variable belongs to which audience (scope), the ciphertext is one SOPS file per environment, each app gets a projection of the scopes it receives, a navigable grid shows the whole matrix, and `sync` pushes an environment to Vercel and Railway. No npm dependencies. `sops`, `git` and a clipboard tool must be on PATH.

## Install

```sh
pnpm add -D github:jpvacarezza/sops-env#v0.1.0
```

Not published on npm. Requires Node >= 24 and `sops` >= 3.11.0 with an age key on the machine. `tsx` and `zod` are optional peers: `tsx` runs the Zod schema pass of `audit` (see [Schema validation](#schema-validation)).

## Versioning

Pin a tag in `package.json` (`"sops-env": "github:jpvacarezza/sops-env#v0.1.0"`). pnpm records the commit SHA in the lockfile, and `--frozen-lockfile` is what holds that pin.

## Configure

`secrets.config.mjs` at the repository root, ESM default export. A small example; `apps` and `scopes` are required, everything else falls back to the defaults stated in the comments.

```js
/** @type {import('sops-env').SecretsConfig} */
export default {
  // Optional. Defaults shown.
  store: {
    dir: 'secrets',
    file: '<environment>.enc.yaml', // `<environment>` placeholder required
    sopsConfig: '.sops.yaml',
    tracked: ['README.md', 'STAGING-PROD-CHECKLIST.md'], // prose files allowed next to the ciphertext
  },
  // Optional. Defaults shown; order is the order shown in the grid.
  environments: {
    local: { nodeEnv: 'development', sync: false },
    staging: { nodeEnv: 'staging', sync: true },
    production: { nodeEnv: 'production', sync: true },
  },
  // REQUIRED, at least one. A key maps to a note (string) or null.
  scopes: {
    shared: { keys: { LOG_LEVEL: 'Read by both apps.' } },
    api: {
      keys: {
        DATABASE_URL: null,
        INTERNAL_API_KEY_WEB: 'Must equal web.INTERNAL_API_KEY.',
      },
    },
    web: {
      keys: {
        API_URL: null,
        INTERNAL_API_KEY: 'This app’s secret for calls to the API.',
        NEXT_PUBLIC_SITE_URL: 'Inlined by Next; not parsed by the schema.',
      },
    },
  },
  // REQUIRED, at least one. `scopes` is required per app and must name declared scopes.
  apps: {
    api: {
      scopes: ['shared', 'api'],
      dotenv: 'apps/api/.env.local', // default: apps/<app>/.env.local
      example: 'apps/api/.env.example', // default: apps/<app>/.env.example
      schema: { file: 'apps/api/src/env.ts', exportName: 'parseApiEnv' }, // default: null
      destination: {
        // default: null (not deployable)
        provider: 'railway',
        service: {
          staging: 'RAILWAY_SERVICE_ID_API_STAGING',
          production: 'RAILWAY_SERVICE_ID_API_PRODUCTION',
        },
      },
    },
    web: {
      scopes: ['shared', 'web'],
      destination: { provider: 'vercel', project: 'VERCEL_PROJECT_ID_WEB' },
    },
  },
  // Optional. Defaults to none.
  schemaRunner: { runner: 'tsx', conditions: [], cwd: 'tmp' }, // defaults shown
  publicPrefixes: ['NEXT_PUBLIC_'], // default; vars with these prefixes sync to Vercel as plain text
  pairs: [
    // default: []
    {
      name: 'api ↔ web',
      left: { scope: 'api', key: 'INTERNAL_API_KEY_WEB' },
      right: { scope: 'web', key: 'INTERNAL_API_KEY' },
      relation: 'equal', // or 'differ'
      why: 'web presents this key to the API on every call; a mismatch is a blanket 401.',
    },
  ],
  exemptions: {
    // default: all three empty
    unparsedBySchema: {
      NEXT_PUBLIC_SITE_URL: 'Next only inlines literal reads.',
    },
    platformProvided: { CI: 'Set by GitHub Actions.' },
    derived: { BUILD_ID: 'Assigned by the build from the commit SHA.' },
  },
  placeholderPattern: /REPLACE_ME|change-me/i, // default
  // Environment-variable NAMES only, never credentials. Defaults shown.
  providers: {
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
  // Where `audit` looks for variable reads. Defaults shown.
  contract: {
    sourceRoots: ['apps/*/src'],
    extraFiles: ['apps/*/next.config.js'],
    ignore: ['node_modules', 'out-tsc'],
  },
};
```

An absent `pairs` is `[]`, absent `exemptions` maps are empty, an app without `schema` gets a `schema-unchecked` warning from `audit`, and an app without `destination` is not synced. Resolve-time errors name the field (`apps.web.scopes[1] "shred" is not a declared scope`) and run the shared/app key collision check.

The config holds names only. A note must not start with `age1`, `AGE-SECRET-KEY-` or `ENC[`, and must not contain `=`; the loader rejects it, because a pasted secret is the failure this guards against. The same rule covers pair `name`/`why` and exemption reasons. Provider fields that name a variable (`vercel.token`/`team`, `railway.token`/`project`/`environment.*`, destination `project`/`service.*`) must be UPPER_SNAKE_CASE, and a rejected string is never echoed. A note is shown in the grid and emitted by `list --json` as `note`.

A partial `providers` block merges over the defaults, one level deep: `vercel: { token: 'MY_TOKEN' }` keeps `targets`. Environment names match `/^[a-z][a-z0-9-]*$/`; the environment with `sync: false` (`local` by default) is the laptop one, where placeholders are warnings and dotenv files are checked. `store.file` is one file name with exactly one `<environment>`; `store.dir` is a relative path without `..`.

Types: `import('sops-env').SecretsConfig`; `defineConfig()` is the identity helper for editor completion.

## Commands

Global options: `--config <file>` picks the config (default: nearest `secrets.config.mjs` above the cwd, or `$SOPS_ENV_CONFIG`); `--help` prints usage, `<command> --help` a command's own. With no command, `sops-env` opens the grid, which needs a terminal. An unknown command exits 2; a missing or invalid config exits 1. A command that fails unexpectedly prints one line and exits 1; set `SOPS_ENV_DEBUG=1` for the stack.

- `sops-env init --<env> <age1...> [--<env> <age1...>] [--force]` writes `.sops.yaml` from age public keys (public only, safe to commit). Exits 1 on a bad key, no environments, or an existing file without `--force`.
- `sops-env edit <env>` opens one environment's ciphertext in `sops`. Exits 1 on an unknown environment.
- `<value on stdin> | sops-env set <env|all> <scope> <KEY> [--sync]` writes one declared variable; the value is read from stdin, never from `sops-env`'s argv. `--sync` dry-runs `sync` for the app the scope feeds, then offers the real one. Exits 1 on error.
- `sops-env unset <env|all> <scope> <KEY>` removes one variable. Takes no value; `--sync` is refused because providers only upsert.
- `sops-env run <env> <app> -- <command...>` decrypts, projects the app's scopes and runs the command with them in its environment. Writes nothing to disk. Exits 1 on setup errors.
- `sops-env materialize <env> <app|all>` writes the app's dotenv file (mode 0600, generated, gitignored). It refuses, before writing anything, a target `git check-ignore` does not confirm as ignored and an existing file without the generated header; `apps.<app>.dotenv` must stay under the config root. Exits 1 on error.
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
- A configured `schema.file` that does not exist is `schema-missing` (error), so a typo cannot switch the gate off.
- `schemaRunner.runner: 'node'` runs JS-only schemas without `tsx`.
- `schemaRunner.conditions` become `--conditions=<name>` in the child's `NODE_OPTIONS`, so workspace packages resolve to sources without a build.
- `schemaRunner.cwd` is where the child runs: `'tmp'` (default, a directory with no `.env` files) or a path relative to the config.
- The child's environment is yours minus every variable the registry knows, plus the projection, with `NODE_ENV` taken from the environment's `nodeEnv`.
- `audit --no-schema` skips the pass.

## Properties

- Values leave a process only as fingerprints or behind a closure; `list`, `check`, `audit` and dry-run print names.
- Presence is read from ciphertext without an age key.
- Fingerprints are HMAC with a per-run random salt, eight hex chars.
- A value is never an argument to `sops-env`: stdin or a masked prompt. It reaches `sops set` on the child's stdin (`--value-stdin`).
- A platform error is printed with every synced value replaced by `<redacted>`, capped at 500 characters.
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

Behavior-changing PRs are verified before and after against that fixture; see [docs/verification.md](docs/verification.md). Design decisions are in [docs/adr/](docs/adr/README.md).

## Origin and license

Extracted from tripgency's in-repo secrets tooling; MIT.
