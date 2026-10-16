/**
 * `pnpm secrets:audit` — the questions about *values*, and the one that fails.
 *
 * `env-contract.spec.mjs` compares four lists of variable *names* and is green
 * today. `secrets:list` adds presence per environment. Neither can answer:
 *
 *   - does each value satisfy the schema that will parse it at boot? A 10-character
 *     TRIPGENCY_INTERNAL_API_KEY passes `secrets:check --decrypt` and then fails
 *     `.min(32)` when the API starts.
 *   - do the cross-scope pairs still line up? `docs/ops/secrets.md` asks a human
 *     to keep api.TRIPGENCY_INTERNAL_API_KEY_WEB equal to
 *     web.TRIPGENCY_INTERNAL_API_KEY; nothing checked it.
 *   - is anything still a placeholder? `secrets/STAGING-PROD-CHECKLIST.md` is a
 *     list of REPLACE_ME values a person is expected to remember.
 *
 * This reads ciphertext, never the platform. A variable set by hand in the
 * Railway or Vercel dashboard is invisible here, exactly as it is to
 * `secrets:sync` — `docs/ops/secrets.md` covers that case, and this cannot.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from './decrypt.mjs';
import { readEnvironment } from './inventory.mjs';
import {
  checkPairs,
  findPlaceholders,
  pairFindings,
  PLACEHOLDER,
  placeholderFindings,
} from './invariants.mjs';
import { NOT_DRIFT_WHEN_UNSET, readDeclarations } from './list.mjs';
import { buildMatrix } from './matrix.mjs';
import { secretsFilePath } from './paths.mjs';
import { projectEnv } from './project.mjs';
import { APPS, DEPLOYABLE_APPS, ENVIRONMENTS, SCOPE_KEYS } from './scopes.mjs';

// Re-exported: the placeholder check moved to `invariants.mjs` so the grid could
// run it without pulling in the audit's process-spawning machinery, and the audit
// stays the one place that names everything it checks.
export { findPlaceholders, PLACEHOLDER, placeholderFindings };

export const USAGE = `Usage: pnpm secrets:audit [--no-schema] [environment...]

  --no-schema   Skip the Zod pass, which spawns one tsx process per app.

Exits non-zero when anything is wrong. Environments default to:
${ENVIRONMENTS.join(', ')}.`;

/**
 * NODE_ENV as the platform will set it, so the schema's production-only
 * refinements actually fire.
 *
 * The store sets NODE_ENV in no environment, so a projection alone falls back to
 * the schema default of `development` and every `NODE_ENV === 'production'`
 * refinement is silently disarmed — including the one that makes GOOGLE_CLIENT_ID
 * required. ADR-0018 gives each environment its own deploy, and #163 added
 * `staging` to the enum precisely so the platform could set it, so this is what
 * the app will really see. A NODE_ENV in the store still wins over this.
 */
export const ASSUMED_NODE_ENV = {
  local: 'development',
  staging: 'staging',
  production: 'production',
};

/**
 * The environment the child gets: this process's, minus every variable the
 * registry knows about, plus the projection.
 *
 * Stripping first is what makes the answer about the store rather than about the
 * shell it ran in — a DATABASE_URL exported in your terminal would otherwise
 * satisfy a schema the store cannot.
 */
export function childEnvironment(
  projection,
  { environment, base = process.env, registry = SCOPE_KEYS } = {},
) {
  const known = new Set(Object.values(registry).flat());
  const inherited = Object.fromEntries(
    Object.entries(base).filter(([key]) => !known.has(key)),
  );

  return {
    ...inherited,
    NODE_ENV: ASSUMED_NODE_ENV[environment] ?? 'development',
    ...projection,
    // `--conditions` maps @tripgency/* to src/, so nothing has to be built
    // first. Passed through NODE_OPTIONS because tsx owns its own argv, and
    // appended rather than assigned so a developer's own flags survive.
    NODE_OPTIONS: [base.NODE_OPTIONS, '--conditions=@org/source']
      .filter(Boolean)
      .join(' '),
  };
}

function defaultRunValidator({ app, env }) {
  const require = createRequire(import.meta.url);

  // process.execPath plus a resolved .mjs entry, never a node_modules/.bin
  // shim: those are extensionless shell scripts that spawnSync cannot exec on
  // Windows, and it reports that as status null rather than as a failure.
  return spawnSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      fileURLToPath(new URL('./validate-projection.ts', import.meta.url)),
      app,
    ],
    {
      encoding: 'utf8',
      env,
      // Somewhere with no .env files: api's loader calls dotenv on paths
      // relative to the CWD, and a stray apps/api/.env.local would add
      // variables the store does not have and mask a real gap.
      cwd: tmpdir(),
      timeout: 60_000,
    },
  );
}

/** Run one app's schema over its projection of one environment. */
export function validateProjection(
  { environment, app, document },
  { runValidator = defaultRunValidator, registry = SCOPE_KEYS } = {},
) {
  const projection = projectEnv(document, app, { registry });
  const result = runValidator({
    app,
    env: childEnvironment(projection, { environment, registry }),
  });

  if (result.error) {
    return {
      state: 'unavailable',
      message: `Could not run the validator: ${result.error.message}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      state: 'unavailable',
      message:
        'The validator printed no verdict. stderr: ' +
        `${(result.stderr || '').trim().split('\n').slice(-3).join(' ')}`,
    };
  }

  if (parsed.ok) return { state: 'ok' };

  // A validator that could not load its own subject has said nothing about the
  // store. Reporting that as `invalid` would read as "production's config is
  // wrong" when the truth is "this tool is broken", which is a worse error than
  // no error at all.
  return parsed.kind === 'load'
    ? { state: 'unavailable', message: parsed.message }
    : { state: 'invalid', message: parsed.message };
}

export function schemaFindings(environment, app, outcome) {
  if (outcome.state === 'ok') return [];

  if (outcome.state === 'unavailable') {
    return [
      {
        code: 'schema-unchecked',
        severity: 'warn',
        scope: app,
        key: '(schema)',
        environment,
        message: `Could not validate the ${app} projection of ${environment}: ${outcome.message}`,
      },
    ];
  }

  return [
    {
      code: 'schema-invalid',
      severity: 'error',
      scope: app,
      key: '(schema)',
      environment,
      message:
        `The ${app} projection of ${environment} does not satisfy its own Zod ` +
        `schema, so the app would fail at boot:\n${outcome.message}`,
    },
  ];
}

export function auditEnvironments({
  environments = ENVIRONMENTS,
  withSchema = true,
  decrypt = decryptSecretsFile,
  runValidator = defaultRunValidator,
  registry = SCOPE_KEYS,
} = {}) {
  const inventories = {};
  const findings = [];
  const notes = [];

  for (const environment of environments) {
    const file = secretsFilePath(environment);
    inventories[environment] = readEnvironment(file).inventory;

    let document;
    try {
      document = decrypt(file);
    } catch (error) {
      findings.push({
        code: 'undecryptable',
        severity: 'warn',
        scope: '-',
        key: '(values)',
        environment,
        message:
          `Cannot read the values of ${environment}, so nothing about them was ` +
          `checked: ${error.message.split('\n')[0]}`,
      });
      continue;
    }

    findings.push(
      ...placeholderFindings(environment, findPlaceholders(document)),
    );
    findings.push(
      ...pairFindings(
        environment,
        checkPairs((scope, key) => document[scope]?.[key]),
      ),
    );

    if (!withSchema) continue;

    for (const app of APPS) {
      // An app outside DEPLOYABLE_APPS — `ingest` until it has a platform —
      // has no `staging` or `production` for its schema to fail against;
      // spawning the validator there anyway is the same drift
      // `buildMatrix`'s DEPLOYABLE_APPS check already keeps out of
      // `missing-required` (matrix.mjs). `local` is real for every app, so it
      // is always validated.
      if (environment !== 'local' && !DEPLOYABLE_APPS.includes(app)) continue;

      findings.push(
        ...schemaFindings(
          environment,
          app,
          validateProjection(
            { environment, app, document },
            { runValidator, registry },
          ),
        ),
      );
    }
  }

  // Presence lives in the same report, so one command answers "is the store
  // sound?" instead of two half-answers.
  const matrix = buildMatrix({
    registry,
    environments,
    inventories,
    declarations: readDeclarations(),
    exemptions: NOT_DRIFT_WHEN_UNSET,
  });
  findings.push(...matrix.findings);

  if (withSchema) {
    notes.push(
      'The Zod pass assumes NODE_ENV matches the environment name, because the ' +
        'store sets it nowhere and the platform does.',
    );
  }
  notes.push(
    'This reads ciphertext, not the platform. A value set by hand in a Vercel ' +
      'or Railway dashboard is invisible here.',
  );

  return {
    findings,
    notes,
    errors: findings.filter((finding) => finding.severity === 'error'),
    warnings: findings.filter((finding) => finding.severity === 'warn'),
  };
}

export function parseAuditArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  for (const flag of flags) {
    if (!['--no-schema', '--help'].includes(flag)) {
      throw new Error(`Unknown flag "${flag}".\n\n${USAGE}`);
    }
  }

  const requested = argv.filter((arg) => !arg.startsWith('--'));
  for (const environment of requested) {
    if (!ENVIRONMENTS.includes(environment)) {
      throw new Error(
        `Unknown environment "${environment}". Expected one of: ${ENVIRONMENTS.join(', ')}.`,
      );
    }
  }

  return {
    environments: requested.length > 0 ? requested : ENVIRONMENTS,
    withSchema: !flags.includes('--no-schema'),
    help: flags.includes('--help'),
  };
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseAuditArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { errors, warnings, notes } = auditEnvironments(options);

    for (const finding of errors) {
      console.error(`error ${finding.code}: ${finding.message}`);
    }
    for (const finding of warnings) {
      console.log(`warn  ${finding.code}: ${finding.message}`);
    }
    for (const note of notes) console.log(`note  ${note}`);

    console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
    return errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
