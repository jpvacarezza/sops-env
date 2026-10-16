/**
 * Grid geometry: how wide each column is and how the screen divides between the
 * grid and the side pane. Pure arithmetic over rows; no state, no painting.
 */
import { schemaMarker } from '../commands/list.mjs';

// Rows sit under their scope header, and the cursor marker lives in the gutter
// to the left of them rather than pushing the whole column across.
export const GUTTER = '    ';

const CELL_MIN = 5;

export const SIDE_GAP = 2;

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
