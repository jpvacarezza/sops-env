# sops-env

SOPS + age secrets for a monorepo. A config file is the registry of which variable belongs to which audience (scope), the ciphertext is one SOPS file per environment, each app gets a projection of the scopes it receives, a navigable grid shows the whole matrix, and `sync` pushes an environment to Vercel and Railway. No npm dependencies. `sops`, `git` and a clipboard tool must be on PATH.

## Install

```sh
pnpm add -D github:jpvacarezza/sops-env#v0.2.1
```

Not published on npm. Requires Node >= 24 and `sops` >= 3.11.0 with an age key on the machine. The optional schema pass of `audit` runs your own validator command, in any language (see [Schema validation](#schema-validation)).

## Versioning

Pin a tag in `package.json` (`"sops-env": "github:jpvacarezza/sops-env#v0.2.1"`). pnpm records the commit SHA in the lockfile, and `--frozen-lockfile` is what holds that pin.

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
        SERVICE_KEY_WEB: 'Must equal web.SERVICE_KEY.',
      },
    },
    web: {
      keys: {
        API_URL: null,
        SERVICE_KEY: 'This app’s secret for calls to the API.',
        NEXT_PUBLIC_SITE_URL: 'Inlined by Next; not declared by the schema.',
      },
    },
  },
  // REQUIRED, at least one. `scopes` is required per app and must name declared scopes.
  apps: {
    api: {
      scopes: ['shared', 'api'],
      dotenv: 'apps/api/.env.local', // default: apps/<app>/.env.local
      example: 'apps/api/.env.example', // default: apps/<app>/.env.example
      schema: {
        // default: null. At least one of `keys` and `command`.
        keys: 'apps/api/env.schema.json', // JSON Schema read for names only
        command: ['python', '-m', 'api.config'], // your validator, an argv
        cwd: 'tmp', // default
      },
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
  publicPrefixes: ['NEXT_PUBLIC_'], // default; vars with these prefixes sync to Vercel as plain text
  pairs: [
    // default: []
    {
      name: 'api ↔ web',
      left: { scope: 'api', key: 'SERVICE_KEY_WEB' },
      right: { scope: 'web', key: 'SERVICE_KEY' },
      relation: 'equal', // or 'differ'
      why: 'web presents this key to the API on every call; a mismatch is a blanket 401.',
    },
  ],
  exemptions: {
    // default: all three empty
    undeclared: {
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

An absent `pairs` is `[]`, absent `exemptions` maps are empty, an app without `schema.command` gets a `schema-unchecked` warning from `audit`, and an app without `destination` is not synced. Resolve-time errors name the field (`apps.web.scopes[1] "shred" is not a declared scope`) and run the shared/app key collision check.

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

sops-env does not parse your schema. An app's `schema` has two independent parts, and each is optional:

- **`command`** is the app's own validator: an argv, run without a shell, in any language. `audit` runs it over each app's projection of each environment, so a store that would fail at boot is an error before it ships.
- **`keys`** is a JSON Schema document read only for the variable names it declares: `properties`, `required` and `default`. It feeds the grid's `req`/`opt`/default markers and the `missing-required` check. It never judges a value, and it is not an alternative to `command`.

### The command contract

The command gets the app's projection in its environment, plus `SOPS_ENVIRONMENT` (the environment name) and `NODE_ENV` (the environment's `nodeEnv`; a `NODE_ENV` in the store wins). Variables the registry knows are removed from what it inherits from your shell, so the answer is about the store, not about your terminal. It runs in `schema.cwd`: `'tmp'` (default, a directory with no `.env` files) or a path relative to the config.

| Exit status   | Meaning                                                      | `audit` reports           |
| ------------- | ------------------------------------------------------------ | ------------------------- |
| `0`           | the environment is valid                                     | nothing                   |
| `78`          | the validator could not run (it could not load its own code) | `schema-unchecked` (warn) |
| anything else | the environment is invalid                                   | `schema-invalid` (error)  |

- What the command prints (stderr, else stdout) is the message. Every value of the projection is redacted from it and it is capped at 500 characters, so a validator that quotes the value it rejected does not leak it. Print variable names and constraints anyway.
- A command that is not found is `schema-missing` (error), so a typo cannot switch the gate off. A command that cannot be started, times out (60 s) or is killed by a signal is `schema-unchecked` (warn). An app without `command` is `schema-unchecked` too. None of these is a verdict about the store.
- `audit --no-schema` skips the pass.

### Recipes

Every recipe is the same shape: load the app's validator, run it over the process environment, exit `0`, `1` or `78`.

```js
// Node, Zod: apps/api/validate-env.mjs, run as ['node', 'apps/api/validate-env.mjs']
let parseApiEnv;
try {
  ({ parseApiEnv } = await import('./src/env.mjs'));
} catch (error) {
  console.error(error.message);
  process.exit(78);
}

try {
  parseApiEnv(process.env);
} catch (error) {
  const issues = error.issues?.map((i) => `${i.path.join('.')}: ${i.message}`);
  console.error(issues?.join('\n') ?? error.message);
  process.exit(1);
}
```

```python
# Python, pydantic: api/validate_env.py, run as ['python', '-m', 'api.validate_env']
import sys
from pydantic import ValidationError

try:
    from api.settings import Settings
except ImportError as error:
    print(error, file=sys.stderr)
    sys.exit(78)

try:
    Settings()  # a pydantic-settings BaseSettings reads os.environ itself
except ValidationError as error:
    for issue in error.errors(include_input=False):
        print(".".join(map(str, issue["loc"])) + ": " + issue["msg"], file=sys.stderr)
    sys.exit(1)
```

A Go or Rust binary that parses its own configuration and exits non-zero on failure needs no wrapper. For a TypeScript validator, run it through `tsx` or `node --experimental-strip-types` in the `command`. Write `command` paths as absolute paths when the command is a script: it runs in `schema.cwd`, not in your repository root (`new URL('./x.py', import.meta.url)` in `secrets.config.mjs` gives one).

### The keys file

Generate it from your model so it cannot drift: `z.toJSONSchema(EnvSchema)` with Zod 4, `Settings.model_json_schema()` with pydantic. Only `properties` (names must be UPPER_SNAKE_CASE), `required` and each property's `default` are read. A property with a `default` is a default even when it is also `required`. A document with no `properties` is an error, not an empty contract.

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

MIT.
