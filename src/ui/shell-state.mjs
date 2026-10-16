/**
 * The navigation state machine: rows, selection, and `reduce`. Pure; effects
 * are data. See `shell.mjs` for the contract.
 */
import { columnWidths, split } from './shell-layout.mjs';

export const SEVERITY_RANK = { error: 2, warn: 1 };

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

export function isPrompting(menu) {
  return typeof menu?.draft === 'string';
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

export function initialState({
  matrix,
  environments,
  values = 'none',
  destinations = {},
}) {
  const rows = buildRows(matrix);
  const firstError = rows.find((row) => row.severity === 'error');

  return {
    rows,
    environments,
    destinations,
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

/** `railway/api`, `vercel/web` — the labels the loop read from the providers; `app` when it has none. */
export function destinations(state, apps) {
  return apps.map((app) => state.destinations[app] ?? app).join(', ');
}
