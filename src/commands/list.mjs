/**
 * `sops-env list` — what exists where, as a grid.
 *
 * Read-only and its own command rather than a flag on the writer, because it is
 * the diagnostic: the first run of an early version of this is what found
 * `BETTER_AUTH_URL_ADMIN` set in `local` and missing from staging and
 * production, with `env-contract.spec.mjs` green the whole time.
 *
 * Exits 0 even with findings. It is a viewer, and a viewer that fails breaks
 * every pipe it is read through; `sops-env audit` is the one that fails.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { readSchemaDeclarations, schemaFile } from '../model/env-contract.mjs';
import { readEnvironment } from '../store/inventory.mjs';
import {
  checkPairs,
  findPlaceholders,
  pairFindings,
} from '../model/invariants.mjs';
import { materializedFindings } from '../model/materialized.mjs';
import { buildMatrix, countBySeverity } from '../model/matrix.mjs';
import { secretsFilePath } from '../store/paths.mjs';

export const usage = (
  ctx,
) => `Usage: sops-env list [--fingerprints] [--json] [environment...]

  --fingerprints  Decrypt and show a per-run salted HMAC of each value (8 hex).
                  Equal fingerprints mean equal values. No value is printed.
                  Also checks the cross-scope key invariants.
  --json          Emit the model instead of the grid.

Environments default to: ${ctx.environments.join(', ')}.`;

const KNOWN_FLAGS = ['--fingerprints', '--json', '--help'];

export function parseListArgs(ctx, argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  for (const flag of flags) {
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new Error(
        `Unknown flag "${flag}". Expected one of: ${KNOWN_FLAGS.join(', ')}.\n\n${usage(ctx)}`,
      );
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
    withFingerprints: flags.has('--fingerprints'),
    asJson: flags.has('--json'),
    help: flags.has('--help'),
  };
}

/** Schema declarations per app that has a schema, read as text. Never imported — see env-contract. */
export function readDeclarations(ctx, { readFile = readFileSync } = {}) {
  return Object.fromEntries(
    ctx.apps
      .map((app) => [app, schemaFile(ctx, app)])
      .filter(([, file]) => file !== null)
      .map(([app, file]) => [
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
export function collect(
  ctx,
  {
    environments,
    // Two flags, not one. Reading the values is what the placeholder and cross-key
    // checks need; showing a fingerprint is a display choice, and `renderShell`
    // draws whatever fingerprints the matrix carries. Tied together, the grid could
    // not run those checks without also putting fingerprints on screen in a mode
    // nobody had turned on.
    withValues = false,
    withFingerprints = false,
    decrypt = decryptSecretsFile,
    readFile = readFileSync,
    salt = randomBytes(32),
  } = {},
) {
  const fingerprint = (value) =>
    createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 8);

  const inventories = {};
  const meta = {};
  const fingerprints = {};
  const lookups = {};
  const placeholders = {};

  for (const environment of environments) {
    const file = secretsFilePath(ctx, environment);
    if (!existsSync(file)) {
      meta[environment] = { exists: false, values: 'absent' };
      continue;
    }

    const read = readEnvironment(ctx, file, { readFile });
    inventories[environment] = read.inventory;
    meta[environment] = {
      exists: true,
      recipients: read.recipients.length,
      lastModified: read.lastModified,
      values: withValues || withFingerprints ? 'pending' : 'not-requested',
    };

    if (!withValues && !withFingerprints) continue;

    try {
      const document = decrypt(file);

      if (withFingerprints) {
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
      }

      // Names only, never the value: a placeholder is a fact about a cell, and
      // this object is handed to callers that must not hold plaintext.
      placeholders[environment] = findPlaceholders(ctx, document);
      lookups[environment] = (scope, key) => document[scope]?.[key];
      meta[environment].values = 'ok';
    } catch (error) {
      // No age key for this environment, or no sops on PATH. The grid still
      // works whole: presence never needed a key.
      meta[environment].values = 'unavailable';
      meta[environment].valuesError = error.message.split('\n')[0];
    }
  }

  return { inventories, meta, fingerprints, lookups, placeholders };
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

// Wide enough for a long key plus a gap: a 32-character name still fits, and a name that touches its neighbour reads as one token.
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
      lines.push('    (empty on purpose — see secrets.config.mjs)');
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

export function main(ctx, argv) {
  let options;
  try {
    options = parseListArgs(ctx, argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.help) {
    console.log(usage(ctx));
    return 0;
  }

  try {
    const { inventories, meta, fingerprints, lookups } = collect(ctx, options);
    const declarations = readDeclarations(ctx);
    const matrix = buildMatrix(ctx, {
      environments: options.environments,
      inventories,
      declarations,
      fingerprints,
    });

    // Store versus this disk, which nothing else asks. Unconditional rather than
    // behind `--fingerprints`: it needs no age key and decrypts nothing, and a
    // flag would hide it from exactly the run someone makes when already stuck.
    for (const environment of options.environments) {
      if (!inventories[environment]) continue;
      matrix.findings.push(
        ...materializedFindings(ctx, {
          environment,
          inventory: inventories[environment],
          declarations,
        }),
      );
    }

    let pairs = null;
    if (options.withFingerprints) {
      pairs = {};
      for (const environment of options.environments) {
        const lookup = lookups[environment];
        if (!lookup) continue;
        const results = checkPairs(ctx, lookup);
        pairs[environment] = results;
        matrix.findings.push(...pairFindings(environment, results));
      }
    }

    // `buildMatrix` counted before the materialized and pair findings existed,
    // and `--json` publishes `counts` for a script to gate on. Recounted here
    // unconditionally: the materialized findings are appended on every run, so
    // leaving this inside the `--fingerprints` branch would publish a `counts`
    // that disagreed with `findings` in the default mode.
    matrix.counts = countBySeverity(matrix.findings);

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
