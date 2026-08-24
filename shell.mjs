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
import { cellMarker, MARKS, schemaMarker } from './list.mjs';
import { destinationFor } from './sync-plan.mjs';

const SEVERITY_RANK = { error: 2, warn: 1 };

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/**
 * One tone per row state: a foreground code, and the background it uses when the
 * row is selected.
 *
 * White on the tone for the selected row rather than the tone alone. The cursor
 * mark is easy to lose in a list of thirty-four; a filled bar is not, and once
 * every row is coloured the mark is no longer the only thing distinguishing one.
 */
const TONES = {
  // `fg` tints the text; `fill` is the whole SGR for a filled bar. Both spelled
  // out rather than derived: every row tone fills with bright white on its own
  // background, but `columns` wants black on white and there is no rule that
  // produces both.
  green: { fg: '32', fill: '97;42' },
  yellow: { fg: '33', fill: '97;43' },
  red: { fg: '31', fill: '97;41' },
  // Not row states. `heading` is the scope rows — blue, a colour none of the row
  // tones use, so a heading is never read as a fourth verdict. `columns` is the
  // line naming the columns: black on white, the one bar that is not a verdict
  // about anything.
  heading: { fg: '34', fill: '97;44' },
  columns: { fg: '30', fill: '30;107' },
};
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
 * Destructive actions are only reachable from the detail panel. `u` on the grid
 * would put "remove this variable from an environment" one keystroke away from
 * the arrow keys.
 */
export function reduce(state, key, { columns = Infinity } = {}) {
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

    // `⏎` acts on the detail, and the pane is where the detail lives. In the grid
    // it is deliberately unused: it used to open a second copy of what the pane is
    // already showing. Unused, but not silent — a key that does nothing without
    // saying so is worse than one that is not bound at all.
    case 'enter':
      if (inDetail || cleared.detail) {
        return {
          state: cleared,
          effect: { kind: 'write', row: selectedRow(cleared) },
        };
      }
      if (pane) {
        return {
          state: { ...cleared, message: '→ into the pane, then ⏎ to edit.' },
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

  return (
    split({ columns, environments: state.environments, values: state.values })
      .side > 0
  );
}

/** Either placement counts as the variable being open. */
function isOpen(state, columns) {
  return state.detail || paneVisible(state, columns);
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

    case 'u':
      if (!isOpen(state, columns)) {
        return {
          state: {
            ...state,
            message:
              'Open the variable first (⏎) — removing is not a grid key.',
          },
          effect: null,
        };
      }
      return { state, effect: { kind: 'unset', row: selectedRow(state) } };

    // The pane prints the values already, so `r` has nothing left to do there. It
    // survives for the panel below, which is all a narrow terminal gets.
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
  '↑↓ move (wraps) · ←→ grid/pane · ⏎ edits, from the pane · ' +
  'u remove · r reveal one value · ' +
  'the pane prints the values it can read · v every value, in the grid · ' +
  'c compare by hex fingerprint, showing none · ' +
  'e only flagged rows · s sync · esc back · q quit';

// Rows sit under their scope header, and the cursor marker lives in the gutter
// to the left of them rather than pushing the whole column across.
const GUTTER = '    ';
const CURSOR = '  ❯ ';

// TRIPGENCY_INTERNAL_API_KEY_ADMIN is 32 characters. At 32 the schema marker
// touched it and read as one token; the same mistake list.mjs already made once.
const NAME_MIN = 34;
// What the names may take beyond their minimum. Past 40 the gap between a name and
// its schema marker is harder to follow than a truncated name would be.
const NAME_SPARE = 6;
const CELL_MIN = 5;
// The widest reason there is measures 29 — `✗ required, not in production` — so 30
// holds every one of them with a column to spare. Measured off `REASONS`, not
// guessed: 52 was a round number and left a third of the column empty.
const REASON_MAX = 30;
const SIDE_GAP = 2;
// Under this the pane stops being a table: `not validated by any schema` wraps
// into four lines and the labels are further apart than the values.
const SIDE_MIN = 30;
// There is no ceiling on the pane. It holds the values now, and one DATABASE_URL is
// past a hundred characters, so every column it gets is a column that URL does not
// wrap over. A ceiling would only leave the slack between the grid and the pane,
// where it does nothing but push the pane right.
const SCHEMA_WIDTH = 14;

/**
 * Column widths for the terminal we actually have.
 *
 * These were fixed constants summing to about 85 columns, so a 120- or
 * 200-column window went unused while the reason for each flag had nowhere to
 * go — the glyph was on screen and its meaning was not. Whatever is spare now
 * goes to the reason column first, and a little to the names.
 *
 * Below the minimum the grid is as narrow as it can be and still line up, and it
 * will overflow rather than start cutting names in half.
 */
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
 * The widest the grid ever wants, so anything past it belongs to the pane.
 *
 * Without this the grid was handed every spare column, stopped growing at its own
 * caps, and the leftover sat between the last cell and the pane — pushing the pane
 * to the right edge of a wide terminal for no reason.
 */
function gridAppetite({ environments, values }) {
  return (
    GUTTER.length +
    NAME_MIN +
    NAME_SPARE +
    SCHEMA_WIDTH +
    cellWanted(values) * environments.length +
    REASON_MAX +
    1
  );
}

export function layout({ columns, environments, values = 'none' }) {
  const width = columns ?? 100;
  const count = environments.length;
  // The flag glyph sits past the cells. Leaving it out of the arithmetic made the
  // grid one column wider than the terminal in a band around 85, and every
  // flagged row wrapped.
  const base = GUTTER.length + NAME_MIN + SCHEMA_WIDTH + 1;

  const wanted = cellWanted(values);
  // What it can have. Derived, not floored per mode: fixed per-mode minimums
  // meant a mode simply did not fit some terminals, and the rows wrapped rather
  // than the cells getting narrower.
  const cell = Math.max(
    CELL_MIN,
    Math.min(wanted, Math.floor(Math.max(0, width - base) / count)),
  );
  const spare = Math.max(0, width - base - cell * count);
  // A reason needs about 18 columns to say anything. Below that it is a stub —
  // `\u2717 required,\u2026` tells you less than the glyph alone — so the column goes
  // away and the flag speaks for itself, with the full text in the detail panel.
  // Value mode never shows one: the cells are the point there.
  const reason =
    values === 'value' || spare < 18 ? 0 : Math.min(REASON_MAX, spare);
  // Whatever the reason column did not take goes to the names.
  const name = NAME_MIN + Math.min(NAME_SPARE, Math.max(0, spare - reason));

  return {
    name,
    schema: SCHEMA_WIDTH,
    cell,
    reason,
    // What a row occupies, so every row can be padded to the same bar. `reason`
    // floors at 1 because `elide(text, 0)` keeps one character — the flag glyph,
    // which is the whole point of the column reserved for it in `base`.
    total:
      GUTTER.length + name + SCHEMA_WIDTH + cell * count + Math.max(reason, 1),
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
 * How the terminal divides between the grid and the detail pane.
 *
 * The grid's floor is built from the same constants `layout` uses, so the two
 * cannot drift: the pane only gets what is left once the grid can still draw a
 * name, a schema marker and one cell per environment.
 *
 * `side: 0` means it does not fit, and `need` is what it would take. The message
 * quotes that number rather than saying "too narrow", because "too narrow for
 * what" is the only part the reader cannot work out for themselves.
 */
export function split({ columns, environments, values = 'none' }) {
  const floor =
    GUTTER.length +
    NAME_MIN +
    SCHEMA_WIDTH +
    1 +
    CELL_MIN * environments.length;
  const need = floor + SIDE_GAP + SIDE_MIN;
  const room = columns - floor - SIDE_GAP;

  if (room < SIDE_MIN) return { grid: columns, side: 0, need };

  // Everything the grid does not want. `room` is the ceiling: past it the grid
  // drops below its floor.
  const side = Math.min(
    room,
    Math.max(
      SIDE_MIN,
      columns - SIDE_GAP - gridAppetite({ environments, values }),
    ),
  );

  return { grid: columns - SIDE_GAP - side, side, need };
}

/**
 * Where anything in a cell starts, counted from the cell's left edge.
 *
 * Two offsets, and they differ on purpose. A **heading** starts on the second
 * column, because `PROD` is four characters and a five-wide cell has no room to
 * start it any later. A **value** starts on the third, which puts the glyph under
 * the middle of a three-letter heading rather than under its first letter.
 *
 * What matters is that each is the same in all three columns. Centring gave three
 * offsets in one grid: a lone `●` centred in five landed on the third column while
 * `● 7dc7e0…` began on the second, and `PROD` centred one column left of `DEV`. The
 * eye read them as columns that do not line up, which is what they were.
 */
const HEADING_AT = 1;
const VALUE_AT = 2;

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
  const pane =
    state.values === 'value'
      ? // Value mode takes every column for the cells; a pane beside them would
        // leave neither enough room to read.
        { grid: total, side: 0, need: 0 }
      : split({
          columns: total,
          environments: state.environments,
          values: state.values,
        });
  const grid = pane.grid;
  const width = layout({
    columns: grid,
    environments: state.environments,
    values: state.values,
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
    (width.reason > 0 ? '  Why' : '');
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
    const cells = state.environments.map((environment) => {
      const cell = row.cells[environment];
      const mark = cellMarker(cell, row.declared);
      // The note comes from a function the caller supplies, never from the
      // model: `buildMatrix` holds no decrypted value and a spec pins that with
      // a sentinel. A value shown here arrives through the same closure
      // `collect` hands out, and goes no further than this string.
      const note = cellNote ? cellNote(environment, row) : cell.fingerprint;

      if (!note) return inCell(mark, width.cell, VALUE_AT);

      return inCell(
        `${mark} ${elide(note, width.cell - VALUE_AT - 2)}`,
        width.cell,
        VALUE_AT,
      );
    });
    const reason = elide(
      reasonFor(row, state.environments.length),
      width.reason,
    );

    // Padded to the full grid width, so a selected row's background is one bar
    // rather than an edge that stops wherever that row's reason text happened to.
    const text = (
      (here ? CURSOR : GUTTER) +
      row.key.padEnd(width.name) +
      schemaMarker(row.schema).padEnd(width.schema) +
      cells.join('') +
      reason
    ).padEnd(width.total);

    // Painted last, after every pad and elide has counted characters.
    lines.push(
      paint(text, rowTone(row, state.environments), { colors, fill: here }),
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
    prose(
      `  ${MARKS.set} set   ${MARKS.unset} declared, not set   ` +
        `${MARKS.absent} not declared either   ✗ error   ⚑ warning`,
      grid,
    ),
  );
  if (colors) {
    // Each word in the tone it names, so the legend is the thing it describes.
    // Kept short by hand rather than passed through `prose`: that measures
    // `.length`, which a painted string overstates by however many escapes it
    // carries. 62 columns, under the 71 the narrowest supported terminal has.
    lines.push(
      `  ${paint('green', 'green', { colors })} all set   ` +
        `${paint('yellow', 'yellow', { colors })} optional, unset   ` +
        `${paint('red', 'red', { colors })} required, unset`,
    );
  }
  // Wrapped, not capped. A message here can be longer than a terminal — the help
  // text always is, and `prose` was silently cutting it after the first clause.
  lines.push(
    ...wrap((state.message ?? hints(state, pane, total)).trim(), total, '  '),
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

  // The panel below comes first: once it is open, "the pane does not fit" is no
  // longer the useful thing to say — the reader already did what that message asks.
  if (state.detail) {
    return '⏎ edit · u remove · r reveal · esc back · q quit';
  }
  if (state.values !== 'value' && !showing) {
    return (
      `The detail pane needs ${pane.need} columns and this terminal has ` +
      `${columns}. Widen it, or press ⏎ for the same detail below the grid.`
    );
  }
  if (state.pane === 'detail' && showing) {
    return '↑↓ environment · ← back to the grid · ⏎ edit · c hide the values · q quit';
  }
  if (showing) {
    return '↑↓ move · → the pane, then ⏎ to edit · v values · c compare · e errors · s sync · q quit';
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
function cellTone(row, environment) {
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
