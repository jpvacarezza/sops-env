/**
 * `sops-env` — the grid, navigable.
 *
 * This file is the loop and nothing else: it paints what `shell.mjs` renders,
 * reads a key, and performs the effect the reducer asked for. Every effect is
 * carried out by code that already existed and is already tested —
 * `writeAcrossEnvironments`, `offerSync`, `readHidden`. The
 * grid is one more caller of the write path, not a second write path.
 *
 * Raw mode is handed back before anything that reads input its own way. A key
 * reader holding raw mode while `readHidden` or `ask` also wants it is two things
 * fighting over one stream, and the visible symptom is a prompt that eats
 * keystrokes — so the reader is closed and reopened around each of those.
 */
import { copyToClipboard } from './clipboard.mjs';
import { collect, readDeclarations } from '../commands/list.mjs';
import {
  checkPairs,
  pairFindings,
  placeholderFindings,
} from '../model/invariants.mjs';
import { buildMatrix, countBySeverity } from '../model/matrix.mjs';
import { destinationFor } from '../model/sync-plan.mjs';
import { secretsFilePath } from '../store/paths.mjs';
import { ask, parseConfirm, parseMultiChoice, readHidden } from './prompt.mjs';
import { createScreen, fitBlock } from './screen.mjs';
import {
  assertCleanSecrets,
  secretsDiffStat,
  offerSync,
  writeAcrossEnvironments,
} from '../commands/set.mjs';
import { assertWritable } from '../model/set-plan.mjs';
import {
  colorSupport,
  initialState,
  needsReload,
  reduce,
  renderShell,
  selectedIndex,
  visibleRows,
  CELL_NOTICE,
} from './shell.mjs';

export const usage = (ctx) => `Usage: sops-env [environment...]

The grid, navigable. Needs a terminal.

  ↑↓        move            ⏎  cell menu in the pane (set / clear / copy)
  ←→        move between the grid and the pane
  v         real values
  c         compare cells by hex fingerprint, without showing a value
  e         only flagged    r  reveal (from the panel below)
  s         sync
  ?         help            q  quit

Environments default to: ${ctx.environments.join(', ')}.
For scripts, use sops-env list / set / audit instead.`;

/** Everything the grid needs, in one read. */
export function load(ctx, { environments, withFingerprints }) {
  const { inventories, meta, fingerprints, lookups, placeholders } = collect(
    ctx,
    {
      environments,
      // Always read the values: the placeholder and cross-key checks below need
      // them, and a row cannot be coloured honestly before they have run —
      // `production.api.DATABASE_URL` held a REPLACE_ME and would have been green.
      // Measured at 142ms for three environments against 2ms for the inventory
      // alone, and an environment whose age key is absent still degrades to
      // `values: unavailable` rather than failing.
      withValues: true,
      // Only when the mode shows them. `renderShell` draws whatever fingerprints
      // the matrix carries, so handing it any would put them on screen in a mode
      // nobody turned on.
      withFingerprints,
    },
  );

  const matrix = buildMatrix(ctx, {
    environments,
    inventories,
    declarations: readDeclarations(ctx),
    fingerprints,
  });

  for (const environment of environments) {
    const lookup = lookups[environment];
    if (!lookup) continue;
    matrix.findings.push(
      ...pairFindings(environment, checkPairs(ctx, lookup)),
      // A `REPLACE_ME` in production is set, encrypted, and not a value. Without
      // this the row would be green, which is the one thing green must not say.
      ...placeholderFindings(ctx, environment, placeholders[environment] ?? []),
    );
  }
  matrix.counts = countBySeverity(matrix.findings);

  return { matrix, meta, lookups };
}

/**
 * Ask which environments and what value, then write through the primitive.
 *
 * One value per environment, never one for all three: reusing a staging key
 * in production is a mistake, and an offer to
 * do it in one keystroke is the wrong shape of convenience.
 */
async function editRow(ctx, row, environments, { screen, environment }) {
  screen.write('\n');
  screen.write(`  ${row.scope}.${row.key}\n`);

  let chosen;
  if (environment) {
    screen.write(`    ${environment}\n`);
    chosen = [environment];
  } else {
    environments.forEach((name, index) => {
      const cell = row.cells[name];
      screen.write(
        `    ${index + 1}) ${name.padEnd(12)}${cell.present ? 'already set' : 'not set'}\n`,
      );
    });

    chosen = parseMultiChoice(
      await ask('  environments (1,3 or all) > '),
      environments.length,
    ).map((index) => environments[index]);
  }

  const values = {};
  for (const environment of chosen) {
    values[environment] = await readHidden(`  value for ${environment} > `);
    if (values[environment] === '') {
      throw new Error(
        'An empty value and an unset variable mean different things to the ' +
          'schemas. Nothing written — use Clear value in the cell menu instead.',
      );
    }
  }

  screen.write('\n  about to write\n');
  for (const environment of chosen) {
    screen.write(
      `    ${row.scope}.${row.key} → ${ctx.relative(secretsFilePath(ctx, environment))}` +
        `  (${Buffer.byteLength(values[environment], 'utf8')} bytes)\n`,
    );
  }

  if (!parseConfirm(await ask('  write it? (y/N) > '))) {
    screen.write('  Nothing was written.\n');
    return false;
  }

  return applyWrite(
    ctx,
    {
      environments: chosen,
      scope: row.scope,
      key: row.key,
      values,
      mode: 'set',
    },
    { screen },
  ).changed;
}

/** The one place this file writes, so the reporting is in one place too. */
function applyWrite(ctx, target, { screen, quiet = false } = {}) {
  assertWritable(ctx, target);
  assertCleanSecrets(ctx);

  const { applied, failed } = writeAcrossEnvironments(ctx, target);

  if (!quiet) {
    for (const entry of applied) {
      screen.write(
        entry.changed
          ? `  ${entry.mode} ${entry.key} in ${entry.file}\n`
          : `  ${entry.key} in ${entry.file} was already that; nothing changed\n`,
      );
    }
  }

  if (failed) {
    if (!quiet) {
      screen.write(`  failed on ${failed.environment}: ${failed.message}\n`);
    }
    return {
      changed: applied.length > 0,
      notice: `Failed on ${failed.environment}: ${failed.message}`,
    };
  }

  if (!quiet) {
    const stat = secretsDiffStat(ctx);
    if (stat.length > 0) {
      screen.write(`\n  git diff -w --numstat -- ${ctx.store.dir}/\n`);
      for (const line of stat) screen.write(`    ${line}\n`);
      screen.write(
        '    3 3 for a changed value, 3 2 for a new key. A fourth line is another value.\n',
      );
    }
  }

  const changed = applied.length > 0;
  const wrote = applied.some((entry) => entry.changed);
  const notice = wrote
    ? target.mode === 'unset'
      ? CELL_NOTICE.cleared
      : CELL_NOTICE.set
    : CELL_NOTICE.unchanged;

  return { changed, notice };
}

export async function run(
  ctx,
  {
    environments = ctx.environments,
    output = process.stdout,
    input = process.stdin,
  } = {},
) {
  if (!input.isTTY) {
    output.write(
      `${usage(ctx)}\n\nStdin is not a terminal, so there is nothing to navigate with.\n`,
    );
    return 1;
  }

  try {
    assertCleanSecrets(ctx);
  } catch (error) {
    output.write(`${error.message}\n`);
    return 1;
  }

  const screen = createScreen({ output, input });
  screen.clear();
  const colors = colorSupport({ isTTY: output.isTTY });
  let values = 'none';
  // Decrypted up front, not on demand: the placeholder and pair checks need the
  // values, and a row cannot be honestly coloured before they have run. Measured
  // at 142ms for three environments, against 2ms without — and an environment
  // whose key is missing degrades to `values: unavailable` in the header rather
  // than failing. Nothing is *shown*: the mode is still `none`.
  // `railway/api`, `vercel/web`: labels the providers know, read here so the
  // shell has no config of its own to consult.
  const destinations = Object.fromEntries(
    ctx.apps
      .map((app) => [app, destinationFor(ctx, app)])
      .filter(([, label]) => label !== null),
  );
  let { matrix, meta, lookups } = load(ctx, {
    environments,
    withFingerprints: false,
  });
  let state = initialState({ matrix, environments, values, destinations });
  let keys = screen.keys();

  /** Hand raw mode back, do something that reads input its own way, take it again. */
  const withOwnInput = async (fn) => {
    keys.close();
    screen.release();
    try {
      await fn();
    } catch (error) {
      screen.write(`\n  ${error.message}\n`);
    }
    await ask('\n  ⏎ to go back ');
    keys = screen.keys();
  };

  const reload = () => {
    ({ matrix, meta, lookups } = load(ctx, {
      environments,
      withFingerprints: values === 'fingerprint',
    }));
    state = {
      ...initialState({ matrix, environments, values, destinations }),
      // Keep the reader where they were. A fresh load would move the cursor to
      // the first error, which after a successful write is a different row.
      selected: state.selected,
      filter: state.filter,
      detail: state.detail,
      pane: state.pane,
      cursor: state.cursor,
      menu: state.menu,
    };
  };

  const writeQuietly = (target) => {
    try {
      return applyWrite(ctx, target, { screen, quiet: true });
    } catch (error) {
      return {
        changed: false,
        notice: String(error.message).split(/\r?\n/)[0],
      };
    }
  };

  const reportMenu = (result) => {
    state = {
      ...state,
      menu: state.menu
        ? { ...state.menu, draft: null, notice: result.notice }
        : state.menu,
    };
    if (result.changed) reload();
    paint();
  };

  /**
   * The decrypted value for one cell, in value mode only.
   *
   * Read through the closure `collect` handed out, so no plain object of values
   * exists to be logged or serialised by accident — the shape `sync-plan.mjs`
   * established. An environment this machine cannot decrypt shows a dash rather
   * than an empty cell, so "no key" never reads as "no value".
   */
  const cellNote = (environment, row) => {
    if (values !== 'value') return row.cells[environment].fingerprint;
    if (!row.cells[environment].present) return null;

    const lookup = lookups[environment];
    if (!lookup) return '—';

    const value = lookup(row.scope, row.key);
    return value === undefined ? '—' : String(value);
  };

  /**
   * What the pane prints under an environment.
   *
   * Same closure discipline as `cellNote`: read through what `collect` handed out,
   * so no plain object of values exists to be logged or serialised by accident.
   * `null` means this machine has no key for that environment, which the pane says
   * rather than leaving a blank.
   */
  const cellValue = (environment, row) => {
    const lookup = lookups[environment];
    if (!lookup) return null;

    const value = lookup(row.scope, row.key);
    return value === undefined ? null : String(value);
  };

  const paint = () => {
    const { lines } = fitBlock({
      total: visibleRows(state).length,
      cursor: selectedIndex(state),
      height: output.rows,
      render: (slice) =>
        renderShell(state, {
          meta,
          counts: matrix.counts,
          slice,
          columns: output.columns,
          height: output.rows,
          cellNote,
          cellValue,
          colors,
        }),
    });

    screen.paint(lines);
  };

  paint();

  for (;;) {
    const key = await keys.next();
    // The reducer needs the width: whether `⏎` edits or opens the panel below
    // depends on whether there is room for a pane, and only the terminal knows.
    const { state: next, effect } = reduce(state, key, {
      columns: output.columns,
    });
    state = next;

    if (!effect) {
      paint();
      continue;
    }

    if (effect.kind === 'quit') break;

    if (effect.kind === 'values') {
      const previous = values;
      values = effect.mode;
      if (needsReload(previous, values)) reload();
      // Value mode hides the pane, so the arrows cannot stay pointed at it.
      state = { ...state, values, pane: 'grid' };
      paint();
      continue;
    }

    if (effect.kind === 'reveal') {
      const revealed = {};
      // The pane's cursor narrows this to one environment. Everywhere else `r`
      // means the whole row, which is what it has always meant — and one variable
      // in one environment is the smallest thing this tool can put on a screen.
      const asked = effect.environment ? [effect.environment] : environments;
      for (const environment of asked) {
        const lookup = lookups[environment];
        const value = lookup?.(effect.row.scope, effect.row.key);
        if (value !== undefined) revealed[environment] = value;
      }
      state = {
        ...state,
        revealed: Object.keys(revealed).length > 0 ? revealed : null,
        message: Object.keys(revealed).length
          ? null
          : '  No readable value — press v to decrypt first.',
      };
      paint();
      continue;
    }

    if (effect.kind === 'sync') {
      await withOwnInput(() =>
        // A non-app scope so offerSync picks `all`: from the grid you are syncing
        // an environment, not the one app whose row happens to be under the cursor.
        offerSync(ctx, {
          environments,
          scope: ctx.scopes.find((name) => !ctx.apps.includes(name)) ?? 'all',
        }),
      );
      paint();
      continue;
    }

    if (effect.kind === 'copy') {
      const lookup = lookups[effect.environment];
      const value = lookup?.(effect.row.scope, effect.row.key);
      const notice =
        value === undefined ? CELL_NOTICE.noCopy : CELL_NOTICE.copied;
      if (value !== undefined) copyToClipboard(value, { output });
      state = {
        ...state,
        menu: state.menu ? { ...state.menu, notice } : state.menu,
      };
      paint();
      continue;
    }

    if (effect.kind === 'write' && effect.value !== undefined) {
      const result = writeQuietly({
        environments: [effect.environment],
        scope: effect.row.scope,
        key: effect.row.key,
        values: { [effect.environment]: effect.value },
        mode: 'set',
      });
      reportMenu(result);
      continue;
    }

    if (effect.kind === 'unset' && effect.environment) {
      const result = writeQuietly({
        environments: [effect.environment],
        scope: effect.row.scope,
        key: effect.row.key,
        mode: 'unset',
      });
      reportMenu(result);
      continue;
    }

    if (effect.kind === 'write') {
      let changed = false;
      await withOwnInput(async () => {
        changed = await editRow(ctx, effect.row, environments, {
          screen,
          environment: effect.environment,
        });
      });
      if (changed) reload();
      paint();
      continue;
    }
  }

  keys.close();
  screen.release();
  screen.write('\n');
  return 0;
}

export function main(ctx, argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage(ctx));
    return Promise.resolve(0);
  }

  const requested = argv.filter((arg) => !arg.startsWith('-'));
  for (const environment of requested) {
    if (!ctx.environments.includes(environment)) {
      console.error(
        `Unknown environment "${environment}". Expected one of: ${ctx.environments.join(', ')}.`,
      );
      return Promise.resolve(1);
    }
  }

  return run(ctx, {
    environments: requested.length > 0 ? requested : ctx.environments,
  }).catch((error) => {
    console.error(error.message);
    return 1;
  });
}
