/**
 * The state machine behind `pnpm secrets`, and its rendering. Both pure.
 *
 * `reduce(state, key)` returns the next state and an effect, where an effect is
 * data — `{ kind: 'write' }`, `{ kind: 'sync' }` — and never an action. The loop
 * in `console.mjs` performs them; nothing here touches a terminal, a file or
 * sops.
 *
 * That is what makes the navigation testable, and the reason it is worth doing:
 * `readHidden` shipped putting escape-sequence bytes into secrets precisely
 * because the terminal-facing code had no tests to put a hostile keystroke
 * through.
 *
 * The selection is held as `"scope.KEY"`, not as an index. Filtering the list
 * then cannot move the cursor to an unrelated variable, which an index would do
 * silently — and the next keystroke after that is Enter on whatever is under it.
 */
import { cellMarker, MARKS, schemaMarker } from '../commands/list.mjs';
import { destinationFor } from '../model/sync-plan.mjs';

const SEVERITY_RANK = { error: 2, warn: 1 };

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/**
 * One tone per row state: a foreground code, and the background it uses when the
 * row is selected and every environment agrees. Mixed selections use `celeste`
 * instead, so the fill does not hide the disagreement the dots are showing.
 *
 * White on the tone for a unanimous selected row rather than the tone alone. The
 * cursor mark is easy to lose in a list of thirty-four; a filled bar is not, and
 * once every row is coloured the mark is no longer the only thing distinguishing
 * one.
 */
const TONES = {
  // `fg` tints the text; `fill` is the whole SGR for a filled bar. Both spelled
  // out rather than derived: every row tone fills with bright white on its own
  // background, but `columns` wants black on white and there is no rule that
  // produces both.
  green: { fg: '32', fill: '97;42' },
  yellow: { fg: '33', fill: '97;43' },
  red: { fg: '31', fill: '97;41' },
  // Selected row when the three environments do not agree. Bright cyan, not the
  // heading's navy: a mixed selection is not a scope divider.
  celeste: { fg: '36', fill: '30;106' },
  // Unselected data rows. The verdict lives in the environment cells; tinting
  // the name to match it made every row a different colour and the list unreadable.
  plain: { fg: '97', fill: '97;40' },
  // The grid behind an open cell menu: grey text, no fill, so the modal is the
  // only colour on screen.
  muted: { fg: '90', fill: '90' },
  // Not row states. `heading` is the scope rows — navy, a colour none of the row
  // tones use, so a heading is never read as a fourth verdict. Standard blue
  // (`44`) reads as celeste on the terminals this is used in; 256-colour 18 is
  // the dark bar that still reads as blue. `columns` is the line naming the
  // columns: black on white, the one bar that is not a verdict about anything.
  // `white` is the cell-menu cursor, the same bar on purpose — a choice, not a
  // verdict.
  heading: { fg: '97', fill: '97;48;5;18' },
  columns: { fg: '30', fill: '30;107' },
  white: { fg: '30', fill: '30;107' },
};

/** What ⏎ on a pane environment offers, in the order they are drawn. */
export const CELL_ACTIONS = [
  { id: 'set', label: 'Set value' },
  { id: 'clear', label: 'Clear value' },
  { id: 'copy', label: 'Copy value' },
];
/** How the focused cell is described inside the menu. */
export const CELL_STATUS = {
  set: 'Set in the environment',
  unset: 'Not set in the environment',
};
/** What Set / Clear / Copy report inside the menu, never under the grid. */
export const CELL_NOTICE = {
  typeValue: 'Type the value, then Enter. Esc to cancel.',
  empty: 'Empty value; nothing written.',
  set: 'Set.',
  cleared: 'Cleared.',
  unchanged: 'Nothing changed.',
  copied: 'Copied.',
  noCopy: 'No readable value to copy.',
};

function newCellMenu(overrides = {}) {
  return { selected: 0, notice: null, draft: null, ...overrides };
}

function isPrompting(menu) {
  return typeof menu?.draft === 'string';
}
/** Matches an SGR sequence, for measuring what a line really occupies. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/**
 * Whether to emit colour.
 *
 * `NO_COLOR` wins over everything (no-color.org), `FORCE_COLOR` overrides the
 * TTY check for a pipe that does understand escapes, and otherwise only a real
 * terminal gets them.
 */
export function colorSupport({ env = process.env, isTTY = false } = {}) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;

  return Boolean(isTTY);
}

/**
 * A line's width on screen.
 *
 * Colour is bytes that occupy no columns, so every width calculation has to
 * measure the stripped string — the alternative is the whole layout being wrong
 * by however many escapes a line happens to carry.
 */
export function visibleWidth(text) {
  return String(text).replace(SGR, '').length;
}

/**
 * Paint text, and only ever after it is fully assembled.
 *
 * Never before an `elide` or a `padEnd`: those count characters, and an escape
 * sequence counted as content would make every width in the layout wrong.
 */
function paint(text, tone, { colors, fill = false }) {
  if (!colors) return text;

  const codes = fill ? TONES[tone].fill : TONES[tone].fg;

  return `${ESC}[${codes}m${text}${RESET}`;
}

/**
 * One cell: the glyph sits on that environment's tone, the padding keeps the
 * row's. A mixed selection is a celeste bar with three different dots; filling
 * the whole cell would swallow the bar, and tinting the glyph would lose it
 * inside a fill of the same colour.
 */
function paintCell(cellText, cell, row, { colors, fill }) {
  if (!colors) return cellText;

  const start = cellText.search(/\S/);
  if (start === -1) return paint(cellText, row, { colors, fill });

  return (
    paint(cellText.slice(0, start), row, { colors, fill }) +
    paint(cellText[start], cell, { colors, fill: true }) +
    paint(cellText.slice(start + 1), row, { colors, fill })
  );
}

/**
 * Set everywhere, encrypted everywhere, and flagged nowhere.
 *
 * "Correct" as far as this can see, which is not the same as correct: the
 * platform is outside what it reads, and a value can satisfy every check here
 * and still be the wrong value.
 */
export function isComplete(row, environments) {
  return (
    row.declared &&
    row.severity === null &&
    environments.every((environment) => {
      const cell = row.cells[environment];
      return cell?.present && cell.encrypted !== false;
    })
  );
}

/**
 * The tone a row is drawn in. Every row gets one — there is no uncoloured state,
 * because "no colour" would read as a fourth meaning nobody defined.
 *
 * Precedence, since rows land in more than one of these:
 *
 * 1. **green** — set and encrypted in every environment, flagged nowhere.
 * 2. **red** — an error finding, a plaintext value, or a variable some schema
 *    requires that an environment does not have. An app that will not boot is
 *    not a shade of warning.
 * 3. **yellow** — everything else that is short: missing somewhere without being
 *    required, or carrying a warning.
 *
 * One environment short is enough to colour the row, because the row is a claim
 * about all three.
 *
 * A key no schema declares counts as not required, so missing means yellow. That
 * is the honest reading: nothing in the code says the app needs it. `SENTRY_ORG`
 * is the case — real, used by a CLI, and validated by no Zod schema.
 */
export function rowTone(row, environments) {
  if (isComplete(row, environments)) return 'green';

  const missing = environments.some(
    (environment) => !row.cells[environment]?.present,
  );
  const plaintext = environments.some(
    (environment) => row.cells[environment]?.encrypted === false,
  );
  const required = row.schema?.presence === 'required';

  if (row.severity === 'error' || plaintext || (missing && required)) {
    return 'red';
  }

  return 'yellow';
}

/**
 * The fill a selected row uses.
 *
 * Its own tone when every environment's cell agrees, so a clean row is a green
 * bar and a broken one is a red bar. Celeste when they do not: mixing the three
 * into one verdict is what `rowTone` already does, and filling with that hides
 * the disagreement the dots are there to show.
 */
export function selectedTone(row, environments) {
  if (environments.length === 0) return 'celeste';

  const tones = environments.map((environment) => cellTone(row, environment));

  return tones.every((tone) => tone === tones[0]) ? tones[0] : 'celeste';
}

/** `"api.DATABASE_URL"` — how a row is named in state and in a finding. */
export const rowId = (row) => `${row.scope}.${row.key}`;

/**
 * Flatten the matrix into navigable rows, each carrying its own findings.
 *
 * Scope headers are a rendering concern, not a row: a cursor that can land on one
 * has a state where Enter means nothing.
 */
export function buildRows(matrix) {
  const byKey = new Map();
  for (const finding of matrix.findings) {
    const id = `${finding.scope}.${finding.key}`;
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(finding);
  }

  // `buildMatrix` hangs the receiving apps off the scope group, not the row, and
  // the detail panel wants them per row.
  const apps = new Map(
    matrix.scopes.map((group) => [group.scope, group.receivingApps]),
  );

  return matrix.rows.map((row) => {
    const findings = byKey.get(rowId(row)) ?? [];
    const severity = findings.reduce(
      (worst, finding) =>
        (SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)
          ? finding.severity
          : worst,
      null,
    );

    return {
      ...row,
      findings,
      severity,
      receivingApps: apps.get(row.scope) ?? [row.scope],
    };
  });
}

export function visibleRows(state) {
  if (state.filter !== 'errors') return state.rows;

  const flagged = state.rows.filter((row) => row.severity !== null);
  // An empty result would leave nothing to select and no way back except the
  // key that got you here, so a filter that matches nothing does not apply.
  return flagged.length > 0 ? flagged : state.rows;
}

export function selectedIndex(state) {
  const visible = visibleRows(state);
  const index = visible.findIndex((row) => rowId(row) === state.selected);
  if (index !== -1) return index;

  // The selection was filtered out. Land on the row nearest to where it sat in
  // the full list rather than jumping to the top.
  const previous = state.rows.findIndex((row) => rowId(row) === state.selected);
  if (previous === -1) return 0;

  let best = 0;
  let distance = Infinity;
  visible.forEach((row, candidate) => {
    const at = state.rows.findIndex((entry) => rowId(entry) === rowId(row));
    const gap = Math.abs(at - previous);
    if (gap < distance) {
      distance = gap;
      best = candidate;
    }
  });

  return best;
}

export function selectedRow(state) {
  return visibleRows(state)[selectedIndex(state)] ?? null;
}

/**
 * Opening state: the cursor starts on the first error.
 *
 * Five errors among thirty-four rows means starting at the top is starting with a
 * search. The whole point of the grid is that the thing to fix is the thing you
 * are looking at.
 */
export const VALUE_MODES = ['none', 'fingerprint', 'value'];

export function initialState({ matrix, environments, values = 'none' }) {
  const rows = buildRows(matrix);
  const firstError = rows.find((row) => row.severity === 'error');

  return {
    rows,
    environments,
    selected: rowId(firstError ?? rows[0] ?? { scope: '', key: '' }),
    filter: 'all',
    values,
    detail: false,
    // No flag for the pane: it is open whenever it can be, so there is nothing to
    // remember. `pane` is which side the arrows drive; `cursor` is an index into
    // `environments`, so it stays valid as the grid selection moves.
    pane: 'grid',
    cursor: 0,
    menu: null,
    revealed: null,
    message: null,
  };
}

function move(state, delta) {
  const visible = visibleRows(state);
  if (visible.length === 0) return state;

  // Wraps at both ends: past the last row is the first, before the first is the
  // last. A page or Home/End still clamps, because those mean "as far as that
  // way" and landing at the opposite end of the list would be a different verb.
  const from = selectedIndex(state);
  const next = Number.isFinite(delta)
    ? (((from + delta) % visible.length) + visible.length) % visible.length
    : Math.min(Math.max(0, from + delta), visible.length - 1);

  return {
    ...state,
    selected: rowId(visible[next]),
    revealed: null,
    message: null,
  };
}

/** The detail pane's own cursor, over the environments. Wraps, like `move`. */
function moveCursor(state, delta) {
  const count = state.environments.length;
  if (count === 0) return state;

  return {
    ...state,
    cursor: (((state.cursor + delta) % count) + count) % count,
    revealed: null,
  };
}

/** Like `move`, but stopping at the ends: a page means "as far as that way". */
function page(state, delta) {
  const visible = visibleRows(state);
  if (visible.length === 0) return state;

  const next = Math.min(
    Math.max(0, selectedIndex(state) + delta),
    visible.length - 1,
  );

  return {
    ...state,
    selected: rowId(visible[next]),
    revealed: null,
    message: null,
  };
}

const PAGE = 10;

/**
 * One keystroke. Returns `{ state, effect }`; `effect` is null when the keystroke
 * only moved something.
 *
 * Clearing a cell is only reachable from the cell menu. A grid key for it would
 * put "remove this variable from an environment" one keystroke away from the
 * arrow keys.
 */
export function reduce(state, key, { columns = Infinity } = {}) {
  if (state.menu) return reduceMenu(state, key);

  const cleared = { ...state, message: null };
  // What `⏎` and `→` mean depends on whether the pane is actually drawn, and that
  // is a question about the terminal. Defaulting to Infinity means "assume there
  // is room", which is the right assumption for a caller that has no width.
  const pane = paneVisible(cleared, columns);
  const inDetail = cleared.pane === 'detail' && pane;

  switch (key.name) {
    case 'up':
      return {
        state: inDetail ? moveCursor(cleared, -1) : move(cleared, -1),
        effect: null,
      };
    case 'down':
      return {
        state: inDetail ? moveCursor(cleared, 1) : move(cleared, 1),
        effect: null,
      };
    case 'pageup':
      return { state: inDetail ? cleared : page(cleared, -PAGE), effect: null };
    case 'pagedown':
      return { state: inDetail ? cleared : page(cleared, PAGE), effect: null };
    case 'home':
      return {
        state: inDetail ? cleared : move(cleared, -Infinity),
        effect: null,
      };
    case 'end':
      return {
        state: inDetail ? cleared : move(cleared, Infinity),
        effect: null,
      };

    // Only into a pane that is actually on screen. A cursor in a pane nobody can
    // see would swallow the arrow keys with nothing to show for it.
    case 'right':
      return {
        state: pane ? { ...cleared, pane: 'detail' } : cleared,
        effect: null,
      };
    case 'left':
      return { state: { ...cleared, pane: 'grid' }, effect: null };

    // `⏎` in the pane opens a menu over the focused environment, because that
    // keystroke already named which cell. Asking 1/2/3 again would be the same
    // question. In the panel below there is no focused environment, so `⏎` still
    // writes the row and the prompt asks. In the grid it is deliberately unused.
    case 'enter':
      if (inDetail) {
        return {
          state: { ...cleared, menu: newCellMenu() },
          effect: null,
        };
      }
      if (cleared.detail) {
        return {
          state: cleared,
          effect: { kind: 'write', row: selectedRow(cleared) },
        };
      }
      if (pane) {
        return {
          state: {
            ...cleared,
            message: '→ into the pane, then ⏎ for the cell menu.',
          },
          effect: null,
        };
      }
      // No pane: value mode, or a terminal too narrow for one. This is the only
      // way left to reach the detail, so `⏎` opens it below.
      return { state: { ...cleared, detail: true }, effect: null };

    // Back one step at a time: out of the pane, then out of the panel below and
    // whatever was revealed. There is nothing that closes the pane: it is open
    // whenever it can be.
    case 'escape':
      if (cleared.pane === 'detail') {
        return { state: { ...cleared, pane: 'grid' }, effect: null };
      }
      return {
        state: { ...cleared, detail: false, revealed: null },
        effect: null,
      };

    case 'cancel':
      return { state: cleared, effect: { kind: 'quit' } };

    case 'char':
      return reduceChar(cleared, key.char.toLowerCase(), columns);

    default:
      return { state: cleared, effect: null };
  }
}

/**
 * The cell menu is its own mode: arrows pick an action, they do not move the
 * grid or the pane. Escape closes it. Set collects the value inside the dialog;
 * Clear and Copy keep it open and report there, so nothing lands under the grid.
 */
function reduceMenu(state, key) {
  if (isPrompting(state.menu)) return reduceDraft(state, key);

  const count = CELL_ACTIONS.length;
  const at = (selected) => ({
    ...state,
    menu: { ...state.menu, selected },
  });

  switch (key.name) {
    case 'up':
      return {
        state: at((state.menu.selected + count - 1) % count),
        effect: null,
      };
    case 'down':
      return {
        state: at((state.menu.selected + 1) % count),
        effect: null,
      };
    case 'enter': {
      const action = CELL_ACTIONS[state.menu.selected];
      const row = selectedRow(state);
      const environment = state.environments[state.cursor];

      if (action.id === 'set') {
        return {
          state: {
            ...state,
            menu: {
              ...state.menu,
              draft: '',
              notice: CELL_NOTICE.typeValue,
            },
          },
          effect: null,
        };
      }
      const present = Boolean(row.cells[environment]?.present);
      // The modal already says the cell is empty. Dropping to a line under the
      // frozen grid (`is not set in production`) plus `⏎ to go back` was that
      // same fact a second time, off the dialog.
      if (!present && (action.id === 'clear' || action.id === 'copy')) {
        return { state, effect: null };
      }
      if (action.id === 'clear') {
        return {
          state: {
            ...state,
            menu: { ...state.menu, notice: null },
          },
          effect: { kind: 'unset', row, environment },
        };
      }
      return {
        state: {
          ...state,
          menu: { ...state.menu, notice: null },
        },
        effect: { kind: 'copy', row, environment },
      };
    }
    case 'escape':
      return { state: { ...state, menu: null }, effect: null };
    case 'cancel':
      return { state, effect: { kind: 'quit' } };
    case 'char':
      if (key.char.toLowerCase() === 'q') {
        return { state, effect: { kind: 'quit' } };
      }
      return { state, effect: null };
    default:
      return { state, effect: null };
  }
}

/**
 * Set value, typed in the dialog. The characters never echo; the footer keeps
 * the key hints. Escape returns to the menu without writing.
 */
function reduceDraft(state, key) {
  const draft = state.menu.draft;
  const setDraft = (next, notice = CELL_NOTICE.typeValue) => ({
    ...state,
    menu: { ...state.menu, draft: next, notice },
  });

  switch (key.name) {
    case 'escape':
      return {
        state: {
          ...state,
          menu: { ...state.menu, draft: null, notice: null },
        },
        effect: null,
      };
    case 'enter':
      if (draft === '') {
        return { state: setDraft(draft, CELL_NOTICE.empty), effect: null };
      }
      return {
        state: {
          ...state,
          menu: { ...state.menu, draft: null, notice: null },
        },
        effect: {
          kind: 'write',
          row: selectedRow(state),
          environment: state.environments[state.cursor],
          value: draft,
        },
      };
    case 'backspace': {
      const points = Array.from(draft);
      if (points.length === 0) return { state, effect: null };
      return {
        state: setDraft(points.slice(0, -1).join('')),
        effect: null,
      };
    }
    case 'space':
      return { state: setDraft(`${draft} `), effect: null };
    case 'char':
      return { state: setDraft(`${draft}${key.char}`), effect: null };
    case 'cancel':
      return { state, effect: { kind: 'quit' } };
    default:
      return { state, effect: null };
  }
}

/**
 * Whether changing the mode needs the store read again.
 *
 * Only the fingerprints depend on the mode. The values are read on every load, so
 * `none ↔ value` reuses what is already in hand; comparing is the one mode that
 * needs something the others do not, and it needs a read in both directions —
 * entering, to have the hex to draw, and leaving, so the cells stop drawing it.
 *
 * This was `wasReading !== isReading`, written when both modes worked off the same
 * decrypted documents and the fingerprints came along with them. Once `collect`
 * split `withValues` from `withFingerprints`, `v` and then `c` left the matrix
 * without the fingerprints it was being asked for, and every cell went blank.
 */
export function needsReload(from, to) {
  return (from === 'fingerprint') !== (to === 'fingerprint');
}

/**
 * Whether the pane is on screen.
 *
 * Derived, never stored. It is open by default and closes for exactly two
 * reasons: value mode, where the cells take every column the terminal has and a
 * pane beside them would leave neither room to read; and a terminal too narrow for
 * `split` to give it any columns. Both are conditions, not choices, so a flag would
 * only ever be a second copy of them that could disagree.
 */
export function paneVisible(state, columns) {
  if (state.values === 'value') return false;

  const widths = columnWidths(state.rows, { values: state.values });

  return (
    split({
      columns,
      environments: state.environments,
      values: state.values,
      ...widths,
    }).side > 0
  );
}

function reduceChar(state, char, columns) {
  switch (char) {
    case 'q':
      return { state, effect: { kind: 'quit' } };

    // `v` is values. It used to cycle through fingerprints on the way, which put
    // the mode nobody asked for in front of the one they did — three times.
    // Comparing keeps its own key, so each of the two does one thing.
    case 'v':
      return {
        state,
        effect: {
          kind: 'values',
          mode: state.values === 'value' ? 'none' : 'value',
        },
      };

    case 'c':
      return {
        state,
        effect: {
          kind: 'values',
          mode: state.values === 'fingerprint' ? 'none' : 'fingerprint',
        },
      };

    // `e` for errors. It was `f` for filter, which described the mechanism rather
    // than what you were looking for.
    case 'e':
      return {
        state: {
          ...state,
          filter: state.filter === 'errors' ? 'all' : 'errors',
        },
        effect: null,
      };

    case 's':
      return { state, effect: { kind: 'sync' } };

    // The pane prints the values already, so `r` has nothing left to do there. It
    // survives for the panel below, which is all a narrow terminal gets.
    // Clearing a cell is the menu's Clear value, not a key.
    case 'r':
      if (!state.detail) {
        return {
          state: {
            ...state,
            message: paneVisible(state, columns)
              ? 'The pane already shows the values — c hides them.'
              : 'Open the variable first (⏎) to reveal.',
          },
          effect: null,
        };
      }
      return { state, effect: { kind: 'reveal', row: selectedRow(state) } };

    case '?':
      return { state: { ...state, message: HELP }, effect: null };

    default:
      return { state, effect: null };
  }
}

export const HELP =
  '↑↓ move (wraps) · ←→ grid/pane · ⏎ cell menu, from the pane · ' +
  'r reveal one value · ' +
  'the pane prints the values it can read · v every value, in the grid · ' +
  'c compare by hex fingerprint, showing none · ' +
  'e only flagged rows · s sync · esc back · q quit';

// Rows sit under their scope header, and the cursor marker lives in the gutter
// to the left of them rather than pushing the whole column across.
const GUTTER = '    ';
const CURSOR = '  ❯ ';
const CELL_MIN = 5;
const SIDE_GAP = 2;
const SIDE_MIN = 30;
/** Trailing spaces after the longest variable name, included in its width. */
export const COLUMN_GAP = 2;
/** Trailing spaces after the longest schema marker. */
export const SCHEMA_GAP = 1;
/** Why is the header plus one space — the sentence lives in the pane. */
export const REASON_WIDTH = 4;

/**
 * What one cell would like, by mode.
 *
 * Five for the default view: a cell there holds one glyph, and every column past
 * it was blank. Thirteen for comparing — a marker and eight hex — and everything
 * going for a value, since a truncated secret is worth less the shorter it is.
 */
function cellWanted(values) {
  if (values === 'value') return Infinity;

  return values === 'fingerprint' ? 13 : 5;
}

/**
 * Name / schema / Why widths from the rows on screen, not from a spare budget.
 *
 * Each content column is the longest value it has to hold (or its header, if
 * that is wider) plus its trailing gap, so the pane gets everything the grid
 * does not actually use. Why is a four-column flag: the sentence lives in the pane.
 */
export function columnWidths(rows, { values = 'none' } = {}) {
  let name = 'Variable'.length;
  let schema = 'Schema'.length;

  for (const row of rows ?? []) {
    if (row.key.length > name) name = row.key.length;
    const marker = schemaMarker(row.schema);
    if (marker.length > schema) schema = marker.length;
  }

  return {
    name: name + COLUMN_GAP,
    schema: schema + SCHEMA_GAP,
    reason: values === 'value' ? 0 : REASON_WIDTH,
  };
}

/** The flag alone. The sentence that used to follow it is in the pane. */
function reasonGlyph(row) {
  if (row.severity === null) return '';

  return row.severity === 'error' ? '✗' : '⚑';
}

/**
 * The widest the grid ever wants, so anything past it belongs to the pane.
 */
function gridAppetite({ environments, values, name, schema, reason }) {
  const measured = columnWidths([], { values });

  return (
    GUTTER.length +
    (name ?? measured.name) +
    (schema ?? measured.schema) +
    (reason ?? measured.reason) +
    cellWanted(values) * environments.length
  );
}

export function layout({
  columns,
  environments,
  values = 'none',
  name: nameWidth,
  schema: schemaWidth,
  reason: reasonWidth,
} = {}) {
  const measured = columnWidths([], { values });
  const name = nameWidth ?? measured.name;
  const schema = schemaWidth ?? measured.schema;
  const reason = reasonWidth ?? measured.reason;
  const width = columns ?? 100;
  const count = environments.length;
  const base = GUTTER.length + name + schema + reason;
  const wanted = cellWanted(values);
  const cell = Math.max(
    CELL_MIN,
    Math.min(
      wanted,
      Math.floor(Math.max(0, width - base) / Math.max(count, 1)),
    ),
  );

  return {
    name,
    schema,
    cell,
    reason,
    total: GUTTER.length + name + schema + cell * count + reason,
  };
}

/**
 * What a column is headed with.
 *
 * Fixed labels, not derived from the width: four characters fit the narrowest cell
 * the layout can produce, so a heading never truncates and never changes shape
 * between two terminals. The width-dependent version gave `local staging prod` in
 * one window and `loca stag prod` in another.
 *
 * These are display labels only. `local` is the store's name for the environment —
 * it is the file (`secrets/local.enc.yaml`), the argument (`pnpm secrets:set local
 * …`) and what every message about a write says. A heading is the one place a
 * shorter word costs nothing.
 *
 * An environment the map does not know falls back to its own name, so adding one to
 * `scopes.mjs` renders a heading rather than a blank.
 */
const ENVIRONMENT_LABELS = {
  local: { short: 'DEV', long: 'DEVELOPMENT' },
  staging: { short: 'STG', long: 'STAGING' },
  production: { short: 'PROD', long: 'PRODUCTION' },
};

/** Four characters, for a column heading. */
function columnLabel(name) {
  return ENVIRONMENT_LABELS[name]?.short ?? name.toUpperCase().slice(0, 4);
}

/**
 * The whole word, for the pane's environment rows, where there is room for it.
 *
 * Not for the findings below them: each of those is a sentence that names its own
 * environment ("in local still holds a placeholder"), and a header reading
 * `DEVELOPMENT` over a body reading `local` would look like two different facts.
 *
 * `local` reads `DEVELOPMENT` here. It is a display label like the others: the
 * environment is still `local` in `secrets/local.enc.yaml`, in
 * `pnpm secrets:set local api KEY`, and in every message about a write — and the
 * banner across the top still lists the real three, so the name you would type is
 * never off the screen.
 */
function paneLabel(name) {
  return ENVIRONMENT_LABELS[name]?.long ?? name.toUpperCase();
}

/** A sentence, cut to the terminal rather than allowed to wrap. */
function prose(text, columns) {
  return columns ? elide(text, columns - 1) : text;
}

/**
 * Break a sentence across lines at word boundaries.
 *
 * The finding messages run two or three sentences — the BETTER_AUTH_URL_ADMIN one
 * is 222 characters — and on a single line the terminal wraps them wherever it
 * likes. A wrapped line is one more row than the block counted, which is exactly
 * what puts the top of it out of the rewind's reach. So they are wrapped here,
 * where the count is known.
 */
export function wrap(text, width, indent = '') {
  // At least one column so the loop always makes progress, and never more than
  // asked for: a floor of 20 here quietly broke the one promise this makes.
  const room = Math.max(1, width - indent.length);
  const lines = [];
  let line = '';

  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    // A secret has no spaces, so a revealed value arrives here as one word
    // longer than the terminal. Word wrapping alone leaves it on one line and it
    // wraps anyway, uncounted — so anything wider than the room is hard-broken.
    let rest = word;
    while (rest.length > room) {
      if (line !== '') {
        lines.push(indent + line);
        line = '';
      }
      lines.push(indent + rest.slice(0, room));
      rest = rest.slice(room);
    }

    if (rest === '') continue;
    if (line === '') line = rest;
    else if (line.length + 1 + rest.length <= room) line += ` ${rest}`;
    else {
      lines.push(indent + line);
      line = rest;
    }
  }

  if (line !== '') lines.push(indent + line);

  return lines;
}

/**
 * Join items on the left with a fixed gap, then pad to `width`.
 *
 * Extra space stays on the right so each option keeps its own spacing instead of
 * stretching into a bar. Painted items are measured with `visibleWidth`: padEnd
 * on an SGR string would count the escapes as columns and the row would run past
 * the terminal.
 */
export function spread(items, width, { indent = 2, separator = '  ' } = {}) {
  const list = items.filter((item) => visibleWidth(item) > 0);
  if (list.length === 0) return '';

  let line = ' '.repeat(indent);
  list.forEach((item, index) => {
    line += item;
    if (index < list.length - 1) line += separator;
  });

  const usedNow = visibleWidth(line);
  if (usedNow < width) line += ' '.repeat(width - usedNow);

  return line;
}

function footerFits(items, width, options) {
  const list = items.filter((item) => visibleWidth(item) > 0);
  if (list.length === 0) return true;

  const { indent = 2, separator = '  ' } = options ?? {};
  const content = list.reduce((sum, item) => sum + visibleWidth(item), 0);

  return (
    indent + content + visibleWidth(separator) * Math.max(list.length - 1, 0) <=
    width
  );
}

function footerGroup(items, width, options) {
  if (items.length === 0) return [];
  if (footerFits(items, width, options)) {
    return [spread(items, width, options)];
  }

  const { indent = 2 } = options ?? {};
  const pad = (line) => {
    const used = visibleWidth(line);
    return used < width ? line + ' '.repeat(width - used) : line;
  };
  const lines = [];
  let batch = [];

  for (const item of items) {
    const trial = [...batch, item];
    if (batch.length > 0 && !footerFits(trial, width, options)) {
      lines.push(spread(batch, width, options));
      batch = [];
    }
    if (!footerFits([item], width, options)) {
      lines.push(...wrap(item, width, ' '.repeat(indent)).map(pad));
      continue;
    }
    batch.push(item);
  }

  if (batch.length > 0) lines.push(spread(batch, width, options));

  return lines;
}

/**
 * Glyphs, tones and key hints, as two rows when they fit and three when they
 * do not. Always sized to the terminal, not the grid: the pane sits above this
 * chrome, and a legend truncated to the grid left a hole under the pane.
 */
export function renderFooter(hint, { columns = 80, colors = false } = {}) {
  const symbols = [
    `${MARKS.set} set`,
    `${MARKS.unset} declared, not set`,
    `${MARKS.absent} not declared either`,
    '✗ error',
    '⚑ warning',
  ];
  const tones = colors
    ? [
        `${paint('green', 'green', { colors })} all set`,
        `${paint('yellow', 'yellow', { colors })} optional, unset`,
        `${paint('red', 'red', { colors })} required, unset`,
      ]
    : [];
  const dotted = String(hint).includes(' · ');
  const hintItems = dotted
    ? String(hint)
        .split(/\s*·\s*/)
        .filter(Boolean)
    : [String(hint).trim()].filter(Boolean);
  const gaps = { separator: '  ' };
  const dots = { separator: ' · ' };
  const packed = [...symbols, ...tones];

  if (footerFits(packed, columns, gaps)) {
    return [
      spread(packed, columns, gaps),
      ...footerGroup(hintItems, columns, dotted ? dots : gaps),
    ];
  }

  return [
    ...footerGroup(symbols, columns, gaps),
    ...footerGroup(tones, columns, gaps),
    ...footerGroup(hintItems, columns, dotted ? dots : gaps),
  ];
}

/**
 * How the terminal divides between the grid and the detail pane.
 *
 * The grid keeps only what the columns actually use — longest name, longest
 * schema marker, the Why glyph, one cell per environment — and the pane takes
 * everything past that. Growing the name column used to push the pane right for
 * blank space the grid did not show.
 *
 * `side: 0` means it does not fit, and `need` is what it would take. The message
 * quotes that number rather than saying "too narrow", because "too narrow for
 * what" is the only part the reader cannot work out for themselves.
 */
export function split({
  columns,
  environments,
  values = 'none',
  name: nameWidth,
  schema: schemaWidth,
  reason: reasonWidth,
} = {}) {
  const measured = columnWidths([], { values });
  const name = nameWidth ?? measured.name;
  const schema = schemaWidth ?? measured.schema;
  const reason = reasonWidth ?? measured.reason;
  const floor =
    GUTTER.length + name + schema + reason + CELL_MIN * environments.length;
  const need = floor + SIDE_GAP + SIDE_MIN;
  const room = columns - floor - SIDE_GAP;

  if (room < SIDE_MIN) return { grid: columns, side: 0, need };

  const side = Math.min(
    room,
    Math.max(
      SIDE_MIN,
      columns -
        SIDE_GAP -
        gridAppetite({ environments, values, name, schema, reason }),
    ),
  );

  return { grid: columns - SIDE_GAP - side, side, need };
}

/**
 * Where anything in a cell starts, counted from the cell's left edge.
 *
 * A **heading** starts on the first character of the five-wide cell, so `PROD`
 * still has one trailing space before Why instead of running into it. A **value**
 * sits on the second character under `DEV` and `STG` (the middle letter of a
 * three-letter heading) and on the third under `PROD`, which is the centre of
 * that four-letter word.
 */
const HEADING_AT = 0;

function valueAt(environment) {
  return columnLabel(environment).length >= 4 ? 2 : 1;
}

function inCell(text, width, from) {
  return ' '.repeat(from).concat(text).padEnd(width);
}

/**
 * Why a row is flagged, in a few words.
 *
 * A bare `✗` at the right edge with no legend and no label was unreadable — the
 * one thing a reader needs from a flag is what to do about it. The full message
 * is still in the detail panel; this is the headline.
 */
const REASONS = {
  'missing-required': (findings, total) =>
    findings.length === 1
      ? `required, not in ${findings[0].environment}`
      : `required, not in ${findings.length}/${total}`,
  'missing-everywhere': () => 'declared, never set',
  undeclared: () => 'not in scopes.mjs',
  'not-encrypted': (findings) => `plaintext in ${findings[0].environment}`,
  placeholder: (findings, total) =>
    findings.length === 1
      ? `placeholder in ${findings[0].environment}`
      : `placeholder in ${findings.length}/${total}`,
  'pair-mismatch': () => 'does not match its pair',
  'pair-collision': () => 'shared with the other app',
  'schema-invalid': () => 'its schema rejects it',
  'schema-unchecked': () => 'could not be checked',
  undecryptable: () => 'values unreadable',
};

export function reasonFor(row, environmentCount) {
  if (row.severity === null) return '';

  const worst = row.findings.filter(
    (finding) => finding.severity === row.severity,
  );
  const code = worst[0].code;
  const label = REASONS[code]?.(worst, environmentCount) ?? code;

  return `${row.severity === 'error' ? '✗' : '⚑'} ${label}`;
}

/**
 * Cut to fit, at a word if one is close enough.
 *
 * Cutting mid-word produced `missing from 2 o`, which reads as a different
 * sentence than the one it is. The full text is in the detail panel either way.
 */
export function elide(text, width) {
  if (width <= 0) return text.slice(0, 1);
  if (text.length <= width) return text;

  const hard = text.slice(0, width - 1);
  const space = hard.lastIndexOf(' ');

  return `${(space > width - 8 ? hard.slice(0, space) : hard).trimEnd()}…`;
}

/**
 * The grid, the detail panel and the key hints, as lines.
 *
 * Takes the visible slice as an argument rather than computing it, so the caller
 * owns how much of the terminal it is willing to spend — `viewport` in
 * `screen.mjs` decides that from `process.stdout.rows`.
 */
export function renderShell(
  state,
  {
    meta = {},
    counts = { error: 0, warn: 0 },
    slice = null,
    columns = undefined,
    cellNote = null,
    cellValue = null,
    colors = false,
  } = {},
) {
  const visible = visibleRows(state);
  const index = selectedIndex(state);
  const window = slice ?? { start: 0, size: visible.length, scrolled: false };
  // Every width below is the grid's, not the terminal's. With the pane open they
  // differ, and a line sized to the terminal would run under the pane.
  const total = columns ?? 100;
  const widths = columnWidths(state.rows, { values: state.values });
  const pane =
    state.values === 'value'
      ? // Value mode takes every column for the cells; a pane beside them would
        // leave neither enough room to read.
        { grid: total, side: 0, need: 0 }
      : split({
          columns: total,
          environments: state.environments,
          values: state.values,
          ...widths,
        });
  const grid = pane.grid;
  const width = layout({
    columns: grid,
    environments: state.environments,
    values: state.values,
    ...widths,
  });
  const lines = [];

  const readable = state.environments.filter(
    (name) => meta[name]?.values === 'ok',
  );
  // The mode is named on every repaint, and `value` is shouted. Nobody should be
  // able to screen-share this without noticing that real secrets are on it.
  //
  // `hex compare` carries no readable count, unlike `value`. This whole line is
  // capped to the grid's width, which is narrow while the pane is up, and a longer
  // marker pushed the error counts off the end of it. An environment that could
  // not be decrypted shows no hex at all, which says the same thing in the cells.
  const mode =
    state.values === 'value'
      ? `  ·  SHOWING VALUES (${readable.length}/${state.environments.length} readable)`
      : state.values === 'fingerprint'
        ? '  ·  hex compare'
        : '';

  // Capped like every prose line here: the grid rows are sized by `layout`, but
  // this one is a sentence, and in value mode it is a long one. At 100 columns it
  // was the widest line on screen by five characters — and a line wider than the
  // terminal wraps, which puts the top of the block out of the rewind's reach.
  lines.push(
    prose(
      `  secrets · ${state.environments.join(' ')}${mode}` +
        `          ${counts.error} error(s) · ${counts.warn} warning(s)` +
        `${state.filter === 'errors' ? '  · showing only flagged' : ''}`,
      grid,
    ),
  );
  lines.push('');
  // The pane starts here, so its title bar and the column header are the same
  // row and the two blocks read as one table.
  const headAt = lines.length;
  // One bar across the grid, black on white. Assembled plain and painted whole,
  // which is also why nothing inside it needs to know about colour: every
  // `padEnd` and `centre` here counts characters, and there are none to miscount
  // until the last step. Elided before padding for the same reason the scope rows
  // are: `padEnd` cannot shorten.
  const head =
    GUTTER +
    'Variable'.padEnd(width.name) +
    'Schema'.padEnd(width.schema) +
    state.environments
      .map((name) => inCell(columnLabel(name), width.cell, HEADING_AT))
      .join('') +
    (width.reason > 0 ? 'Why'.padEnd(width.reason) : '');
  lines.push(
    paint(elide(head, width.total).padEnd(width.total), 'columns', {
      colors,
      fill: true,
    }),
  );
  lines.push(
    '  ' +
      MARKS.rule.repeat(
        GUTTER.length -
          2 +
          width.name +
          width.schema +
          width.cell * state.environments.length +
          width.reason,
      ),
  );

  let scope = null;
  const shown = visible.slice(window.start, window.start + window.size);

  if (window.start > 0)
    lines.push(
      `  ${MARKS.absent}${MARKS.absent}${MARKS.absent} ${window.start} above`,
    );

  shown.forEach((row, offset) => {
    if (row.scope !== scope) {
      scope = row.scope;
      // Where the values are pushed, not which scope feeds which app. The latter
      // read `api → api` on every visible row: true, and a tautology, since a
      // scope only ever feeds the app it is named after. `shared` is the one
      // exception and it is deliberately empty.
      // Filled across the grid, unlike the column names, which are filled per
      // word: this line is a divider between scopes and the whole line is the
      // divider. Elided before padding so a long destination list cannot push it
      // past the terminal — `padEnd` would not shorten it.
      const heading = `  ${scope} → ${destinations(row.receivingApps)}`;
      lines.push(
        paint(elide(heading, width.total).padEnd(width.total), 'heading', {
          colors,
          fill: true,
        }),
      );
    }

    const here = window.start + offset === index;
    const tone = here ? selectedTone(row, state.environments) : 'plain';
    const cells = state.environments.map((environment) => {
      const cell = row.cells[environment];
      const mark = cellMarker(cell, row.declared);
      // The note comes from a function the caller supplies, never from the
      // model: `buildMatrix` holds no decrypted value and a spec pins that with
      // a sentinel. A value shown here arrives through the same closure
      // `collect` hands out, and goes no further than this string.
      const note = cellNote ? cellNote(environment, row) : cell.fingerprint;
      const at = valueAt(environment);
      const body = note
        ? inCell(`${mark} ${elide(note, width.cell - at - 2)}`, width.cell, at)
        : inCell(mark, width.cell, at);

      return paintCell(body, cellTone(row, environment), tone, {
        colors,
        fill: here,
      });
    });
    const reason = reasonGlyph(row).padEnd(width.reason);

    // Prefix and suffix are padded to the full grid width, so a selected row's
    // background is one bar rather than an edge that stops wherever that row's
    // reason text happened to. The cells sit in the middle, each glyph on its
    // own tone; the padding around a glyph keeps the row fill so the bar does
    // not punch holes around the dots.
    const prefix =
      (here ? CURSOR : GUTTER) +
      row.key.padEnd(width.name) +
      schemaMarker(row.schema).padEnd(width.schema);
    const pad = Math.max(
      0,
      width.total -
        prefix.length -
        width.cell * state.environments.length -
        reason.length,
    );
    const suffix = reason + ' '.repeat(pad);

    lines.push(
      paint(prefix, tone, { colors, fill: here }) +
        cells.join('') +
        paint(suffix, tone, { colors, fill: here }),
    );
  });

  const below = visible.length - (window.start + window.size);
  if (below > 0)
    lines.push(
      `  ${MARKS.absent}${MARKS.absent}${MARKS.absent} ${below} below`,
    );

  const row = visible[index];
  if (state.detail && row && pane.side === 0) {
    lines.push(...renderDetail(state, row, meta, grid));
  } else if (state.values === 'value' && row && pane.side === 0) {
    // Three full values side by side do not fit any terminal — one DATABASE_URL
    // is past a hundred characters. The cells stay truncated for the overview and
    // the row under the cursor gets shown whole here, so moving the cursor is how
    // you read a value in full rather than a second keystroke.
    //
    // Skipped when the pane is up: its per-environment lines already carry the
    // values, and this would be the same thing again with the grid squeezed for
    // it.
    lines.push(...renderFocus(state, row, cellNote, grid));
  }

  // Where the bottom chrome starts. The pane is capped to what is above it so it
  // can never be written over the legend.
  const chromeAt = lines.length;

  lines.push('');
  lines.push(
    ...renderFooter((state.message ?? hints(state, pane, total)).trim(), {
      columns: total,
      colors,
    }),
  );

  if (pane.side > 0 && row) {
    beside(lines, renderSide(state, row, meta, cellValue, pane.side, colors), {
      at: headAt,
      until: chromeAt,
      grid,
      width: pane.side,
      colors,
    });
  }

  if (state.menu && row) {
    const gray = colors
      ? lines.map((line) =>
          paint(String(line).replace(SGR, ''), 'muted', { colors }),
        )
      : lines;

    return overlayBlock(
      gray,
      renderCellMenu(state, row, { columns: total, colors }),
      { columns: total, colors },
    );
  }

  return lines;
}

/**
 * Write `block` into the right-hand columns of `lines`, in place.
 *
 * Padding is measured with `visibleWidth`, not `.length`: by this point the grid
 * lines carry colour, and padding a painted line by its byte count would push the
 * pane right by however many escapes that row happened to have — a different
 * amount per row, which is a ragged edge rather than a column.
 *
 * Capped at `until`, with the overflow counted rather than dropped silently. A
 * pane that quietly stopped at the legend would read as "that is all there is".
 * The count names no key, because with a pane up there is none: the panel below is
 * only reachable where there is no pane. What is left is a taller terminal.
 */
function beside(lines, block, { at, until, grid, width, colors }) {
  const room = Math.max(0, until - at);
  const shown =
    block.length > room
      ? [
          ...block.slice(0, Math.max(0, room - 1)),
          paint(
            elide(
              `  +${block.length - room + 1} more than this terminal has room for`,
              width,
            ),
            'yellow',
            { colors },
          ),
        ]
      : block;

  shown.forEach((text, offset) => {
    const left = lines[at + offset] ?? '';
    lines[at + offset] =
      left +
      ' '.repeat(Math.max(0, grid - visibleWidth(left)) + SIDE_GAP) +
      text;
  });
}

/**
 * Draw `block` in the middle of `lines`, covering whatever was there.
 *
 * The sides of an overlaid row are stripped of colour: splicing SGR in the
 * middle of a painted line is how the pane used to walk, and a modal that is
 * supposed to be the only thing in focus does not need the grid to remain
 * perfect underneath it.
 */
export function overlayBlock(
  lines,
  block,
  { columns = 80, colors = false } = {},
) {
  if (block.length === 0) return lines;

  const width = Math.max(...block.map((line) => visibleWidth(line)));
  const left = Math.max(0, Math.floor((columns - width) / 2));
  const top = Math.max(0, Math.floor((lines.length - block.length) / 2));
  const restyle = (text) =>
    colors && text.length > 0 ? paint(text, 'muted', { colors }) : text;

  return lines.map((line, index) => {
    const offset = index - top;
    if (offset < 0 || offset >= block.length) return line;

    const plain = String(line).replace(SGR, '').padEnd(columns);
    const piece = block[offset];
    const used = visibleWidth(piece);

    return (
      restyle(plain.slice(0, left)) + piece + restyle(plain.slice(left + used))
    );
  });
}

/**
 * The cell menu: a boxed dialog with the variable name in the header.
 *
 * Inner width is the longest `scope.key` plus six, so the title sits in three
 * spaces on each side when it is that longest name, and is centred when it is
 * shorter. `Set value` is first so a bare ⏎ still means what it used to. The
 * selected row is black on white — the same bar as the column header, a choice
 * rather than a verdict.
 */
function renderCellMenu(state, row, { columns, colors }) {
  const environment = state.environments[state.cursor];
  const title = `${row.scope}.${row.key}`;
  const subtitle = paneLabel(environment);
  const status = row.cells[environment]?.present
    ? CELL_STATUS.set
    : CELL_STATUS.unset;
  const notice = state.menu.notice;
  const prompting = isPrompting(state.menu);
  const hidden = prompting
    ? '*'.repeat(Array.from(state.menu.draft).length)
    : '';
  let longest = Math.max(title.length, status.length);
  if (notice) longest = Math.max(longest, notice.length);
  if (hidden.length > longest) longest = hidden.length;

  for (const entry of state.rows ?? []) {
    const id = `${entry.scope}.${entry.key}`;
    if (id.length > longest) longest = id.length;
  }

  const inner = Math.min(longest + 6, Math.max(8, columns - 2));
  const rule = MARKS.rule.repeat(inner);
  const empty = `│${' '.repeat(inner)}│`;
  const centre = (value) => {
    const shown = elide(value, Math.max(1, inner - 6));
    const rest = inner - shown.length;
    const left = Math.floor(rest / 2);

    return ' '.repeat(left) + shown + ' '.repeat(rest - left);
  };
  const inset = (value) => elide(`   ${value}`, inner).padEnd(inner);
  const option = (label, selected) => {
    const body = inset(label);
    return `│${
      selected ? paint(body, 'white', { colors, fill: true }) : body
    }│`;
  };

  return [
    `┌${rule}┐`,
    empty,
    `│${centre(title)}│`,
    empty,
    `├${rule}┤`,
    empty,
    `│${inset(subtitle)}│`,
    `│${inset(status)}│`,
    empty,
    ...(notice ? [`│${inset(notice)}│`] : []),
    ...(prompting ? [`│${inset(hidden || ' ')}│`] : []),
    ...(notice || prompting ? [empty] : []),
    ...CELL_ACTIONS.map((action, index) =>
      option(action.label, index === state.menu.selected),
    ),
    empty,
    `└${rule}┘`,
  ];
}

/**
 * The key hints, and the one place the pane explains itself.
 *
 * Separated by `·` rather than by runs of spaces: this line is wrapped, and `wrap`
 * splits on whitespace and rejoins with one space, which quietly flattened the
 * grouping that double spaces were there to give.
 *
 * `split` returns what the pane would need, so this quotes the number instead of
 * saying "too narrow" — "too narrow for what" is the only part a reader cannot
 * work out by looking.
 */
function hints(state, pane, columns) {
  const showing = pane.side > 0;

  if (state.menu) {
    if (isPrompting(state.menu)) {
      return 'type the value · ⏎ save · esc cancel';
    }
    return '↑↓ choose · ⏎ confirm · esc back · q quit';
  }
  // The panel below comes first: once it is open, "the pane does not fit" is no
  // longer the useful thing to say — the reader already did what that message asks.
  if (state.detail) {
    return '⏎ edit · r reveal · esc back · q quit';
  }
  if (state.values !== 'value' && !showing) {
    return (
      `The detail pane needs ${pane.need} columns and this terminal has ` +
      `${columns}. Widen it, or press ⏎ for the same detail below the grid.`
    );
  }
  if (state.pane === 'detail' && showing) {
    return '↑↓ environment · ← back to the grid · ⏎ cell menu · c hide the values · q quit';
  }
  if (showing) {
    return '↑↓ move · → the pane, then ⏎ for the cell menu · v values · c compare · e errors · s sync · q quit';
  }

  // Value mode: the pane is hidden and `⏎` reaches the detail below instead.
  return '↑↓ move · ⏎ the detail below · v back from values · e errors · q quit';
}

/** `railway/api`, `vercel/web` — read from the same rule the sync applies. */
function destinations(apps) {
  return apps.map(destinationFor).join(', ');
}

/**
 * The selected row, as a column beside the grid.
 *
 * Same facts as the panel below, laid out down instead of across, and it subsumes
 * the focus panel: in value mode the per-environment lines carry the value rather
 * than `set`, which is what makes a pane at the side worth the columns it costs —
 * the grid stays visible while you read one variable.
 *
 * Capped by the caller to the height of the table it sits next to, so it can never
 * write over the legend.
 */
function renderSide(state, row, meta, cellValue, width, colors) {
  const lines = [
    paint(elide(` ${row.scope}.${row.key}`, width).padEnd(width), 'columns', {
      colors,
      fill: true,
    }),
  ];

  const gutter = 10;
  for (const [label, value] of detailFacts(row)) {
    const [first, ...rest] = wrap(value, width, ' '.repeat(gutter));
    lines.push(label.padEnd(gutter) + (first ?? '').trimStart());
    lines.push(...rest);
  }
  lines.push('');

  // `PRODUCTION` is ten and `DEVELOPMENT` eleven, so 13 leaves two clear columns
  // before the status at the narrowest pane the layout allows.
  const stub = 13;
  const last = state.environments.length - 1;
  state.environments.forEach((environment, at) => {
    const cell = row.cells[environment];
    const status =
      `${cellMarker(cell, row.declared)} ${cell.present ? 'set' : 'not set'}` +
      `${meta[environment]?.values === 'unavailable' ? '  (locked)' : ''}`;
    const label = paneLabel(environment).padEnd(stub);
    const tone = cellTone(row, environment);

    // Filled while the pane has the arrows, tinted while the grid does. The fill
    // is what a cursor looks like, so it only appears on the side you are on;
    // from the grid the same three tones read as text.
    //
    // Only the label line is ever filled: the value below it wraps to two or three
    // lines, and a bar down all of them reads as a selection of the text.
    lines.push(
      state.pane === 'detail' && at === state.cursor
        ? paint(`${label}${status}`.padEnd(width), tone, { colors, fill: true })
        : paint(label, tone, { colors }) + status,
    );

    // The value, under its own environment. `c` swaps it for the fingerprint,
    // which is the whole point of that mode: comparing without showing.
    if (cell.present) {
      const shown =
        state.values === 'fingerprint'
          ? cell.fingerprint
          : cellValue?.(environment, row);

      lines.push(...wrap(shown ?? 'cannot decrypt', width, '  '));
    }

    // One blank line between environments. Without it a wrapped value runs
    // straight into the next label and the three read as one paragraph.
    if (at !== last) lines.push('');
  });

  const flagged = findingsByCode(row);
  if (flagged.length > 0) {
    // A rule with the count in it, so the size of the problem arrives before the
    // reading of it — the same thing the banner does for the whole store. When
    // nothing is flagged there is no rule at all: the absence is the signal, and
    // a heading over an empty section would be a line the pane cannot spare.
    const errors = flagged.filter(([, group]) => group[0].severity === 'error');
    const warns = flagged.length - errors.length;
    const counted = [
      errors.length && `${errors.length} error${errors.length > 1 ? 's' : ''}`,
      warns && `${warns} warning${warns > 1 ? 's' : ''}`,
    ]
      .filter(Boolean)
      .join(' · ');

    lines.push('');
    lines.push(
      elide(
        `${MARKS.rule.repeat(2)} ${counted} ` +
          MARKS.rule.repeat(Math.max(0, width - counted.length - 5)),
        width,
      ),
    );
  }

  for (const [code, group] of flagged) {
    const where = group
      .map((finding) => finding.environment)
      .filter(Boolean)
      .join(' ');

    lines.push('');
    lines.push(
      paint(
        elide(
          `${group[0].severity === 'error' ? '✗' : '⚑'} ${code}${where ? ` — ${where}` : ''}`,
          width,
        ),
        group[0].severity === 'error' ? 'red' : 'yellow',
        { colors },
      ),
    );
    lines.push(...wrap(group[0].message, width, '  '));
  }

  return lines;
}

/** The selected row's values, in full, wrapped. Value mode only. */
function renderFocus(state, row, cellNote, columns) {
  const lines = ['', `  ${row.scope}.${row.key}`];

  for (const environment of state.environments) {
    const label = `  ${environment.padEnd(12)}`;
    const note = cellNote?.(environment, row);
    const text = note ?? (row.cells[environment].present ? '—' : 'not set');
    const [first, ...rest] = wrap(text, columns - 1, ' '.repeat(label.length));

    lines.push(label + (first ?? '').trimStart());
    lines.push(...rest);
  }

  return lines;
}

/**
 * What a row is, as label/value pairs.
 *
 * Shared by both detail panels. They lay it out differently — one across the
 * terminal, one down a narrow column — but a row that reads as `optional` below
 * the grid and `opt` beside it would be two answers to one question.
 */
/**
 * Findings collapsed for display, as `[code, group]` pairs.
 *
 * `missing-required` fires once per environment with the same sentence in each,
 * and reading "is required by the api schema — no default, not optional" twice in
 * a five-line panel buries the part that differs, which is which environments.
 *
 * Grouped by severity as well as by code. `placeholder` fires as a warning in
 * `local`, where placeholders are the documented convention, and as an error
 * anywhere else — and one group labelled from whichever finding came first was
 * printing the production error as a warning.
 */
function findingsByCode(row) {
  const grouped = new Map();

  for (const finding of row.findings) {
    const key = `${finding.severity}:${finding.code}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(finding);
  }

  return [...grouped.values()].map((group) => [group[0].code, group]);
}

function detailFacts(row) {
  return [
    ['scope', `${row.scope} → ${destinations(row.receivingApps)}`],
    [
      'schema',
      row.schema
        ? `${row.schema.presence}${row.schema.defaultLiteral ? ` (${row.schema.defaultLiteral})` : ''} — from the ${row.schema.app} schema`
        : 'not validated by any schema',
    ],
    [
      'registry',
      row.declared
        ? 'declared in scopes.mjs'
        : 'NOT declared — secrets:sync would refuse the projection',
    ],
  ];
}

/**
 * How one cell reads, in the same vocabulary `rowTone` uses for a whole row.
 *
 * The findings for that environment count. Presence alone said green for
 * `production.api.DATABASE_URL` — set, encrypted, and holding a `REPLACE_ME` —
 * which is the one thing green must not say, and the row was already red for it.
 */
export function cellTone(row, environment) {
  const cell = row.cells[environment];
  const worst = row.findings
    .filter((finding) => finding.environment === environment)
    .reduce(
      (rank, finding) => Math.max(rank, SEVERITY_RANK[finding.severity] ?? 0),
      0,
    );

  if (worst === 2 || cell?.encrypted === false) return 'red';
  if (!cell?.present) {
    return row.schema?.presence === 'required' ? 'red' : 'yellow';
  }

  return worst === 1 ? 'yellow' : 'green';
}

function renderDetail(state, row, meta, columns) {
  const lines = [
    '',
    `  ${MARKS.rule.repeat(4)} ${row.key} ${MARKS.rule.repeat(4)}`,
  ];

  for (const [label, value] of detailFacts(row)) {
    lines.push(prose(`  ${label.padEnd(11)}${value}`, columns));
  }

  // No `lastmodified` here. SOPS stamps the file, not the key, so printing it
  // beside "not set" reads as "this variable changed then" — which is the one
  // thing it cannot mean. The file stamps are in the `secrets:list` header.
  for (const environment of state.environments) {
    const cell = row.cells[environment];
    lines.push(
      `  ${environment.padEnd(11)}${cellMarker(cell, row.declared)} ${
        cell.present ? 'set' : 'not set'
      }${cell.fingerprint ? `  ${cell.fingerprint}` : ''}${
        meta[environment]?.values === 'unavailable' ? '  (cannot decrypt)' : ''
      }`,
    );
  }

  if (state.revealed) {
    lines.push('');
    for (const [environment, value] of Object.entries(state.revealed)) {
      // Wrapped, not cut: a revealed value is asked for precisely to be read in
      // full, and this is the one place that shows it whole.
      lines.push(
        ...wrap(`${environment.padEnd(11)}${value}`, columns - 1, '  '),
      );
    }
  }

  for (const [code, group] of findingsByCode(row)) {
    const label = group[0].severity === 'error' ? 'error' : 'warn ';
    const where = group
      .map((finding) => finding.environment)
      .filter(Boolean)
      .join(', ');

    lines.push('');
    lines.push(
      prose(`  ${label} ${code}${where ? ` — ${where}` : ''}`, columns),
    );
    lines.push(...wrap(group[0].message, columns - 1, '        '));
  }

  return lines;
}
