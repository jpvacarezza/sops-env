/**
 * `sops-env audit` — the questions about *values*, and the one that fails.
 *
 * `env-contract.spec.mjs` compares lists of variable *names* and is green
 * today. `sops-env list` adds presence per environment. Neither can answer:
 *
 *   - does each value satisfy the schema that will parse it at boot? A 10-character
 *     key passes `sops-env check --decrypt` and then fails `.min(32)` when the
 *     app starts.
 *   - do the cross-scope pairs still line up? Someone has to keep the two ends of
 *     a pair equal; nothing checked it.
 *   - is anything still a placeholder? A list of REPLACE_ME values is a thing a
 *     person is expected to remember.
 *
 * This reads ciphertext, never the platform. A variable set by hand in the
 * Railway or Vercel dashboard is invisible here, exactly as it is to
 * `sops-env sync`.
 */

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { readEnvironment } from '../store/inventory.mjs';
import {
  checkPairs,
  findPlaceholders,
  pairFindings,
  placeholderFindings,
} from '../model/invariants.mjs';
import { readDeclarations } from './list.mjs';
import { buildMatrix } from '../model/matrix.mjs';
import { secretsFilePath } from '../store/paths.mjs';
import {
  defaultRunValidator,
  schemaFindings,
  validateProjection,
} from '../schema/runner.mjs';

// Re-exported: the placeholder check moved to `invariants.mjs` so the grid could
// run it without pulling in the audit's process-spawning machinery, and the audit
// stays the one place that names everything it checks.
export { findPlaceholders, placeholderFindings };

export const usage = (
  ctx,
) => `Usage: sops-env audit [--no-schema] [environment...]

  --no-schema   Skip the Zod pass, which spawns one tsx process per app.

Exits non-zero when anything is wrong. Environments default to:
${ctx.environments.join(', ')}.`;

export function auditEnvironments(
  ctx,
  {
    environments = ctx.environments,
    withSchema = true,
    decrypt = decryptSecretsFile,
    runValidator = defaultRunValidator,
  } = {},
) {
  const inventories = {};
  const findings = [];
  const notes = [];

  for (const environment of environments) {
    const file = secretsFilePath(ctx, environment);
    inventories[environment] = readEnvironment(ctx, file).inventory;

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
      ...placeholderFindings(environment, findPlaceholders(ctx, document)),
    );
    findings.push(
      ...pairFindings(
        environment,
        checkPairs(ctx, (scope, key) => document[scope]?.[key]),
      ),
    );

    if (!withSchema) continue;

    for (const app of ctx.apps) {
      // An app with no destination (`ctx.deployableApps`) —
      // has no `staging` or `production` for its schema to fail against;
      // spawning the validator there anyway is the same drift
      // `buildMatrix`'s deployable check already keeps out of
      // `missing-required` (matrix.mjs). `local` is real for every app, so it
      // is always validated.
      if (environment !== 'local' && !ctx.deployableApps.includes(app))
        continue;

      findings.push(
        ...schemaFindings(
          environment,
          app,
          validateProjection(
            ctx,
            { environment, app, document },
            { runValidator },
          ),
        ),
      );
    }
  }

  // Presence lives in the same report, so one command answers "is the store
  // sound?" instead of two half-answers.
  const matrix = buildMatrix(ctx, {
    environments,
    inventories,
    declarations: readDeclarations(ctx),
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

export function parseAuditArgs(ctx, argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  for (const flag of flags) {
    if (!['--no-schema', '--help'].includes(flag)) {
      throw new Error(`Unknown flag "${flag}".\n\n${usage(ctx)}`);
    }
  }

  const requested = argv.filter((arg) => !arg.startsWith('--'));
  for (const environment of requested) {
    if (!ctx.environments.includes(environment)) {
      throw new Error(
        `Unknown environment "${environment}". Expected one of: ${ctx.environments.join(', ')}.`,
      );
    }
  }

  return {
    environments: requested.length > 0 ? requested : ctx.environments,
    withSchema: !flags.includes('--no-schema'),
    help: flags.includes('--help'),
  };
}

export function main(ctx, argv) {
  let options;
  try {
    options = parseAuditArgs(ctx, argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.help) {
    console.log(usage(ctx));
    return 0;
  }

  try {
    const { errors, warnings, notes } = auditEnvironments(ctx, options);

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
