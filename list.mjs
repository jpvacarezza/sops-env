/**
 * `pnpm secrets:list` — what exists where, as a grid.
 *
 * Read-only and its own command rather than a flag on the writer, because it is
 * the diagnostic: the first run of an early version of this is what found
 * `BETTER_AUTH_URL_ADMIN` set in `local` and missing from staging and
 * production, with `env-contract.spec.mjs` green the whole time.
 *
 * Exits 0 even with findings. It is a viewer, and a viewer that fails breaks
 * every pipe it is read through; `pnpm secrets:audit` is the one that fails.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from './decrypt.mjs';
import { APP_SCHEMA_FILES, readSchemaDeclarations } from './env-contract.mjs';
import { readEnvironment } from './inventory.mjs';
import { checkPairs, pairFindings } from './invariants.mjs';
import { buildMatrix, countBySeverity } from './matrix.mjs';
import { secretsFilePath } from './paths.mjs';
import {
  DERIVED,
  ENVIRONMENTS,
  PLATFORM_PROVIDED,
  SCOPE_KEYS,
  UNPARSED_BY_ZOD,
} from './scopes.mjs';

/**
 * Keys for which "declared but set nowhere" is a documented state, not drift.
 *
 * `scopes.mjs` already classifies these and says why for each: `UNPARSED_BY_ZOD`
 * is validated at its point of use (the `NEXT_PUBLIC_*` inlining constraint, the
 * build-time Sentry trio), `DERIVED` is written by the build from another
 * variable, and `PLATFORM_PROVIDED` comes from Vercel or GitHub. Warning about
 * them would bury the one case that is real drift — a registry entry a feature
 * added and nobody ever set.
 */
export const NOT_DRIFT_WHEN_UNSET = {
  ...UNPARSED_BY_ZOD,
  ...DERIVED,
  ...PLATFORM_PROVIDED,
};

export const USAGE = `Usage: pnpm secrets:list [--fingerprints] [--json] [environment...]

  --fingerprints  Decrypt and show a per-run salted HMAC of each value (8 hex).
                  Equal fingerprints mean equal values. No value is printed.
                  Also checks the cross-scope key invariants.
  --json          Emit the model instead of the grid.

Environments default to: ${ENVIRONMENTS.join(', ')}.`;

const KNOWN_FLAGS = ['--fingerprints', '--json', '--help'];

export function parseListArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  for (const flag of flags) {
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new Error(
        `Unknown flag "${flag}". Expected one of: ${KNOWN_FLAGS.join(', ')}.\n\n${USAGE}`,
      );
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
    withFingerprints: flags.has('--fingerprints'),
    asJson: flags.has('--json'),
    help: flags.has('--help'),
  };
}

/** Schema declarations per app, read as text. Never imported — see env-contract. */
export function readDeclarations({ readFile = readFileSync } = {}) {
  return Object.fromEntries(
    Object.entries(APP_SCHEMA_FILES).map(([app, file]) => [
      app,
      readSchemaDeclarations(readFile(file, 'utf8')),
    ]),
  );
}

/**
 * Gather everything the grid needs.
 *
 * Decrypted values leave here only as fingerprints and behind a `lookup`
 * closure. That is the shape `sync-plan.mjs` already uses, for the reason its
 * comment gives: a plain object of values is one stray `console.log` or one
 * `JSON.stringify` away from a dump, and a closure is not.
 *
 * The salt is fresh per run, so a fingerprint is comparable across cells of one
 * grid and meaningless anywhere else — which is the only comparison anyone needs.
 */
export function collect({
  environments,
  withFingerprints = false,
  decrypt = decryptSecretsFile,
  readFile = readFileSync,
  salt = randomBytes(32),
} = {}) {
  const fingerprint = (value) =>
    createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 8);

  const inventories = {};
  const meta = {};
  const fingerprints = {};
  const lookups = {};

  for (const environment of environments) {
    const file = secretsFilePath(environment);
    if (!existsSync(file)) {
      meta[environment] = { exists: false, values: 'absent' };
      continue;
    }

    const read = readEnvironment(file, { readFile });
    inventories[environment] = read.inventory;
    meta[environment] = {
      exists: true,
      recipients: read.recipients.length,
      lastModified: read.lastModified,
      values: withFingerprints ? 'pending' : 'not-requested',
    };

    if (!withFingerprints) continue;

    try {
      const document = decrypt(file);

      fingerprints[environment] = Object.fromEntries(
        Object.entries(document)
          .filter(([, entries]) => entries && typeof entries === 'object')
          .map(([scope, entries]) => [
            scope,
            Object.fromEntries(
              Object.entries(entries).map(([key, value]) => [
                key,
                fingerprint(value),
              ]),
            ),
          ]),
      );

      lookups[environment] = (scope, key) => document[scope]?.[key];
      meta[environment].values = 'ok';
    } catch (error) {
      // No age key for this environment, or no sops on PATH. The grid still
      // works whole: presence never needed a key.
      meta[environment].values = 'unavailable';
      meta[environment].valuesError = error.message.split('\n')[0];
    }
  }

  return { inventories, meta, fingerprints, lookups };
}

/**
 * Grid glyphs, in one place so a terminal that cannot render them is a one-line
 * change rather than a hunt. Verified rendering in Git Bash and the VS Code
 * terminal on Windows 10.
 */
export const MARKS = {
  set: '●',
  unset: '○',
  absent: '·',
  plaintext: '!',
  unvalidated: '–',
  rule: '─',
};

// Wide enough for the longest key plus a gap: TRIPGENCY_INTERNAL_API_KEY_ADMIN
// is 32 characters, and a name that touches its neighbour reads as one token.
const NAME_WIDTH = 36;
// `def('false')` is 12 characters and the literal is capped at 8, so the widest
// marker this can emit is `def(12345678)` at 13.
const SCHEMA_WIDTH = 14;

function centre(text, width) {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

export function schemaMarker(schema) {
  if (!schema) return MARKS.unvalidated;
  if (schema.presence === 'required') return 'req';
  if (schema.presence === 'optional') return 'opt';

  const literal = schema.defaultLiteral;
  if (literal === null || literal.length > 8) return 'def(…)';
  return `def(${literal})`;
}

export function cellMarker(cell, declared) {
  if (!cell.present) return declared ? MARKS.unset : MARKS.absent;
  if (cell.encrypted === false) return MARKS.plaintext;
  return MARKS.set;
}

/**
 * Findings, with repetitive codes collapsed to one line.
 *
 * `missing-everywhere` fires once per declared-but-unset variable — fifteen of
 * them today — and fifteen sentences saying the same thing bury the two that
 * matter. A code with more than two instances becomes a count plus its keys; the
 * full messages are always in `--json`.
 */
function renderFindings(findings) {
  const byCode = new Map();
  for (const finding of findings) {
    if (!byCode.has(finding.code)) byCode.set(finding.code, []);
    byCode.get(finding.code).push(finding);
  }

  const lines = [];
  for (const [code, group] of byCode) {
    const label = group[0].severity === 'error' ? 'error' : 'warn ';

    if (group.length <= 2) {
      for (const finding of group) {
        lines.push(`    ${label} ${code}: ${finding.message}`);
      }
      continue;
    }

    const keys = Array.from(
      new Set(group.map((finding) => `${finding.scope}.${finding.key}`)),
    ).join(', ');
    lines.push(`    ${label} ${code} (${group.length}): ${keys}`);
  }

  return lines;
}

/** The grid, as lines. Pure: everything it needs is already in the model. */
export function render(matrix, { meta = {}, pairs = null } = {}) {
  const envWidth = pairs ? 12 : 11;
  const lines = [];
  const rule = MARKS.rule.repeat(
    NAME_WIDTH + SCHEMA_WIDTH + envWidth * matrix.environments.length,
  );

  lines.push('');
  for (const environment of matrix.environments) {
    const info = meta[environment] ?? {};
    const detail = !info.exists
      ? 'no file'
      : [
          `${info.recipients} recipient(s)`,
          info.lastModified ?? 'no stamp',
          info.values === 'ok'
            ? 'values readable'
            : info.values === 'unavailable'
              ? `values unavailable — ${info.valuesError}`
              : null,
        ]
          .filter(Boolean)
          .join(' · ');
    lines.push(`  ${environment.padEnd(12)} ${detail}`);
  }

  lines.push('');
  lines.push(
    '  ' +
      'variable'.padEnd(NAME_WIDTH) +
      'schema'.padEnd(SCHEMA_WIDTH) +
      matrix.environments.map((name) => centre(name, envWidth)).join(''),
  );
  lines.push('  ' + rule);

  for (const group of matrix.scopes) {
    lines.push('');
    lines.push(`  ${group.scope}  →  ${group.receivingApps.join(', ')}`);

    if (group.rows.length === 0) {
      lines.push('    (empty on purpose — see SCOPE_KEYS in scopes.mjs)');
      continue;
    }

    for (const row of group.rows) {
      const cells = matrix.environments.map((environment) => {
        const cell = row.cells[environment];
        const mark = cellMarker(cell, row.declared);
        const suffix = cell.fingerprint ? ` ${cell.fingerprint}` : '';
        return centre(mark + suffix, envWidth);
      });

      lines.push(
        '    ' +
          row.key.padEnd(NAME_WIDTH - 2) +
          schemaMarker(row.schema).padEnd(SCHEMA_WIDTH) +
          cells.join(''),
      );
    }
  }

  lines.push('');
  lines.push('  ' + rule);
  lines.push(
    `  ${MARKS.set} set ${matrix.totals.set}   ${MARKS.unset} declared, unset ${matrix.totals.unset}` +
      (matrix.totals.undeclared
        ? `   ! undeclared ${matrix.totals.undeclared}`
        : ''),
  );
  lines.push(
    `  schema: req required · def(x) has a default · opt optional · ${MARKS.unvalidated} not validated`,
  );

  if (pairs && Object.keys(pairs).length > 0) {
    lines.push('');
    lines.push('  cross-scope invariants');
    lines.push('  ' + rule);
    for (const [environment, results] of Object.entries(pairs)) {
      const summary = results
        .map((result) => `${result.name} ${result.status}`)
        .join('   ');
      lines.push(`    ${environment.padEnd(12)} ${summary}`);
    }
    lines.push(
      '    fingerprints are a per-run HMAC; equal ones mean equal values.',
    );
  }

  const errors = matrix.findings.filter(
    (finding) => finding.severity === 'error',
  );
  const warnings = matrix.findings.filter(
    (finding) => finding.severity === 'warn',
  );

  if (errors.length + warnings.length > 0) {
    lines.push('');
    lines.push(`  ${errors.length} error(s), ${warnings.length} warning(s)`);
    lines.push('  ' + rule);
    lines.push(...renderFindings([...errors, ...warnings]));
  }

  lines.push('');
  return lines;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseListArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { inventories, meta, fingerprints, lookups } = collect(options);
    const matrix = buildMatrix({
      registry: SCOPE_KEYS,
      environments: options.environments,
      inventories,
      declarations: readDeclarations(),
      fingerprints,
      exemptions: NOT_DRIFT_WHEN_UNSET,
    });

    let pairs = null;
    if (options.withFingerprints) {
      pairs = {};
      for (const environment of options.environments) {
        const lookup = lookups[environment];
        if (!lookup) continue;
        const results = checkPairs(lookup);
        pairs[environment] = results;
        matrix.findings.push(...pairFindings(environment, results));
      }

      // `buildMatrix` counted before these existed, and `--json` publishes
      // `counts` for a script to gate on.
      matrix.counts = countBySeverity(matrix.findings);
    }

    if (options.asJson) {
      // `matrix` never held a value and `pairs` carries refs and verdicts only,
      // so this is safe to redirect to a file or paste into a ticket.
      console.log(JSON.stringify({ matrix, meta, pairs }, null, 2));
      return 0;
    }

    for (const line of render(matrix, { meta, pairs })) console.log(line);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
