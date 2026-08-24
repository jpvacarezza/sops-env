import { describe, expect, it } from 'vitest';

import { MARKS } from './list.mjs';
import { buildMatrix } from './matrix.mjs';
import {
  buildRows,
  colorSupport,
  elide,
  initialState,
  layout,
  needsReload,
  VALUE_MODES,
  visibleWidth,
  wrap,
  reasonFor,
  isComplete,
  reduce,
  renderShell,
  rowId,
  rowTone,
  selectedIndex,
  selectedRow,
  split,
  visibleRows,
} from './shell.mjs';

const ENVS = ['local', 'staging'];
const ENVIRONMENTS_THREE = ['local', 'staging', 'production'];

const REGISTRY = {
  shared: [],
  api: ['A_REQ', 'A_DEF', 'A_OPT'],
  web: ['W_REQ'],
  admin: [],
};

const DECLARATIONS = {
  api: {
    A_REQ: { presence: 'required', defaultLiteral: null },
    A_DEF: { presence: 'default', defaultLiteral: "'x'" },
    A_OPT: { presence: 'optional', defaultLiteral: null },
  },
  web: { W_REQ: { presence: 'required', defaultLiteral: null } },
  admin: {},
};

const cell = (keys) => ({
  keys: Object.fromEntries(
    keys.map((key) => [key, { line: 1, encrypted: true }]),
  ),
});

/**
 * A_REQ is required and missing from staging  → one error.
 * A_OPT is optional and set nowhere           → one warning.
 * A_DEF and W_REQ are clean.
 */
const MATRIX = buildMatrix({
  registry: REGISTRY,
  environments: ENVS,
  inventories: {
    local: { api: cell(['A_REQ', 'A_DEF']), web: cell(['W_REQ']) },
    staging: { api: cell(['A_DEF']), web: cell(['W_REQ']) },
  },
  declarations: DECLARATIONS,
});

const start = (overrides = {}) => ({
  ...initialState({ matrix: MATRIX, environments: ENVS }),
  ...overrides,
});

/**
 * The same four variables, padded out to eighteen.
 *
 * The pane is capped to the rows beside it, and with a value under each
 * environment it wants about fifteen lines — more than a four-row grid has to
 * give. Tests that read the pane's contents need a grid tall enough to hold it;
 * the cap itself has its own test.
 */
const FILLER = Array.from({ length: 14 }, (_, index) => `A_FILL_${index}`);
const TALL = buildMatrix({
  registry: {
    shared: [],
    api: ['A_REQ', 'A_DEF', 'A_OPT', ...FILLER],
    web: ['W_REQ'],
    admin: [],
  },
  environments: ENVS,
  inventories: {
    local: { api: cell(['A_REQ', 'A_DEF', ...FILLER]), web: cell(['W_REQ']) },
    staging: { api: cell(['A_DEF', ...FILLER]), web: cell(['W_REQ']) },
  },
  declarations: DECLARATIONS,
});
const tall = (overrides = {}) => ({
  ...initialState({ matrix: TALL, environments: ENVS }),
  ...overrides,
});

const press = (state, name, char) => reduce(state, { name, char });
const chars = (state, char) => reduce(state, { name: 'char', char });
// The pane is drawn whenever there is room, so "no pane" means a terminal too
// narrow for one: 95 columns with these two environments.
const NARROW = 88;
const pressIn = (state, name, columns) => reduce(state, { name }, { columns });
const charsIn = (state, char, columns) =>
  reduce(state, { name: 'char', char }, { columns });

describe('buildRows', () => {
  const rows = buildRows(MATRIX);

  it('has one row per variable and no scope headers', () => {
    expect(rows.map(rowId)).toEqual([
      'api.A_REQ',
      'api.A_DEF',
      'api.A_OPT',
      'web.W_REQ',
    ]);
  });

  it('attaches each row its own findings', () => {
    expect(rows[0].findings.map((finding) => finding.code)).toEqual([
      'missing-required',
    ]);
    expect(rows[1].findings).toEqual([]);
  });

  it('reports the worst severity on the row', () => {
    expect(rows[0].severity).toBe('error');
    expect(rows[2].severity).toBe('warn');
    expect(rows[1].severity).toBeNull();
  });

  // buildMatrix hangs these off the scope group, and the detail panel needs them
  // per row.
  it('carries the receiving apps down from the scope group', () => {
    expect(rows[0].receivingApps).toEqual(['api']);
    expect(rows[3].receivingApps).toEqual(['web']);
  });
});

describe('initialState', () => {
  // Five errors among thirty-four rows means starting at the top is starting
  // with a search.
  it('starts on the first error, not the first row', () => {
    expect(start().selected).toBe('api.A_REQ');
  });

  it('starts on the first row when nothing is flagged', () => {
    const clean = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ENVS,
      inventories: {
        local: { api: cell(['A_DEF']) },
        staging: { api: cell(['A_DEF']) },
      },
      declarations: DECLARATIONS,
    });

    expect(initialState({ matrix: clean, environments: ENVS }).selected).toBe(
      'api.A_DEF',
    );
  });

  it('opens with the detail closed and nothing revealed', () => {
    expect(start()).toMatchObject({ detail: false, revealed: null });
  });
});

describe('moving', () => {
  it('goes down and up', () => {
    const down = press(start(), 'down').state;
    expect(down.selected).toBe('api.A_DEF');
    expect(press(down, 'up').state.selected).toBe('api.A_REQ');
  });

  it('wraps past the last row to the first', () => {
    const last = start({ selected: 'web.W_REQ' });

    expect(press(last, 'down').state.selected).toBe('api.A_REQ');
  });

  it('wraps before the first row to the last', () => {
    expect(press(start(), 'up').state.selected).toBe('web.W_REQ');
  });

  it('comes back to where it started after a full lap', () => {
    let state = start();
    for (let i = 0; i < 4; i += 1) state = press(state, 'down').state;

    expect(state.selected).toBe('api.A_REQ');
  });

  it('jumps to the ends with home and end', () => {
    expect(press(start(), 'end').state.selected).toBe('web.W_REQ');
    expect(press(press(start(), 'end').state, 'home').state.selected).toBe(
      'api.A_REQ',
    );
  });

  // A page means "as far as that way". Landing at the opposite end of the list
  // would be a different verb, so these stop where the arrows would wrap.
  it('pages to the end and stops there', () => {
    const end = press(start(), 'pagedown').state;

    expect(end.selected).toBe('web.W_REQ');
    expect(press(end, 'pagedown').state.selected).toBe('web.W_REQ');
  });

  it('pages to the start and stops there', () => {
    expect(press(start(), 'pageup').state.selected).toBe('api.A_REQ');
  });

  it('drops a revealed value when the cursor moves off the row', () => {
    const revealed = start({ revealed: { local: 'secret' } });

    expect(press(revealed, 'down').state.revealed).toBeNull();
  });

  it('emits no effect for a movement', () => {
    expect(press(start(), 'down').effect).toBeNull();
  });
});

describe('needsReload', () => {
  // The bug this exists for: from value mode, `c` did not re-read, so the matrix
  // held no fingerprints and every cell in the grid went blank. The old rule asked
  // whether a key was needed, which both modes answer the same way.
  it('re-reads when comparing is entered from any other mode', () => {
    expect(needsReload('value', 'fingerprint')).toBe(true);
    expect(needsReload('none', 'fingerprint')).toBe(true);
  });

  // Leaving matters too: the cells draw whatever fingerprints the matrix carries, so
  // stale ones would show hex in a mode that is not asking for it.
  it('re-reads when comparing is left', () => {
    expect(needsReload('fingerprint', 'none')).toBe(true);
    expect(needsReload('fingerprint', 'value')).toBe(true);
  });

  // The values are read on every load, so these reuse what is in hand.
  it('reuses what it has between the other two', () => {
    expect(needsReload('none', 'value')).toBe(false);
    expect(needsReload('value', 'none')).toBe(false);
  });

  it('has nothing to do when the mode does not change', () => {
    for (const mode of VALUE_MODES) expect(needsReload(mode, mode)).toBe(false);
  });
});

describe('the errors filter', () => {
  const filtered = chars(start(), 'e').state;

  it('keeps only flagged rows', () => {
    expect(visibleRows(filtered).map(rowId)).toEqual([
      'api.A_REQ',
      'api.A_OPT',
    ]);
  });

  it('keeps the selected row when it survives the filter', () => {
    expect(selectedRow(filtered).key).toBe('A_REQ');
  });

  // An index would have moved the cursor to an unrelated variable, and the next
  // keystroke after that is Enter on whatever is under it.
  it('lands on the nearest surviving row when the selection is filtered out', () => {
    const onClean = { ...start({ selected: 'api.A_DEF' }), filter: 'errors' };

    expect(selectedRow(onClean).key).toBe('A_REQ');
    expect(selectedIndex(onClean)).toBe(0);
  });

  it('toggles back off', () => {
    expect(chars(filtered, 'e').state.filter).toBe('all');
  });

  it('does not apply a filter that would leave nothing to select', () => {
    const clean = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ENVS,
      inventories: {
        local: { api: cell(['A_DEF']) },
        staging: { api: cell(['A_DEF']) },
      },
      declarations: DECLARATIONS,
    });
    const state = {
      ...initialState({ matrix: clean, environments: ENVS }),
      filter: 'errors',
    };

    expect(visibleRows(state)).toHaveLength(1);
  });
});

describe('opening and editing', () => {
  const inPane = () => press(start(), 'right').state;

  it('asks for a write from the pane, naming the row', () => {
    const { effect } = press(inPane(), 'enter');

    expect(effect.kind).toBe('write');
    expect(effect.row.key).toBe('A_REQ');
  });

  // It used to open a second copy of what the pane is already showing. Unused, but
  // not silent: a key that does nothing without saying so is worse than one that
  // was never bound.
  it('does nothing from the grid, and says where ⏎ works', () => {
    const { state, effect } = press(start(), 'enter');

    expect(effect).toBeNull();
    expect(state.detail).toBe(false);
    expect(state.message).toMatch(/→ into the pane/);
  });

  // With no pane — value mode, or a terminal too narrow for one — this is the only
  // way left to reach the detail.
  it('opens the panel below when there is no pane', () => {
    const opened = pressIn(start(), 'enter', NARROW).state;

    expect(opened.detail).toBe(true);
    expect(pressIn(opened, 'enter', NARROW).effect).toMatchObject({
      kind: 'write',
    });
  });

  it('closes the detail and forgets the revealed value on escape', () => {
    const opened = {
      ...pressIn(start(), 'enter', NARROW).state,
      revealed: { local: 'x' },
    };
    const closed = press(opened, 'escape').state;

    expect(closed).toMatchObject({ detail: false, revealed: null });
  });

  // Nothing takes the pane away: it is open whenever it can be, so there is no
  // flag for escape to clear and no state for it to get wrong.
  it('leaves the pane drawn after escape', () => {
    const after = press(start(), 'escape').state;

    expect(after.pane).toBe('grid');
    expect(renderShell(after, { columns: 140 }).join(' ')).toContain(
      'api.A_REQ',
    );
  });
});

describe('the destructive keys', () => {
  // Neither is a bare grid key: with no detail visible they would put "remove this
  // variable" one keystroke from the arrow keys.
  it.each(['u', 'r'])('says why when no detail is open: %s', (char) => {
    const { state, effect } = charsIn(start(), char, NARROW);

    expect(effect).toBeNull();
    expect(state.message).toMatch(/Open the variable first/);
  });

  it('removes with the pane open', () => {
    expect(chars(start(), 'u').effect).toMatchObject({ kind: 'unset' });
  });

  // The pane prints the values already, so `r` has nothing left to do there.
  it('says so when r would reveal what the pane already shows', () => {
    const { state, effect } = chars(start(), 'r');

    expect(effect).toBeNull();
    expect(state.message).toMatch(/already shows the values/);
  });

  it('removes from the panel below too', () => {
    const opened = pressIn(start(), 'enter', NARROW).state;

    expect(charsIn(opened, 'u', NARROW).effect).toMatchObject({
      kind: 'unset',
    });
  });
});

describe('the other keys', () => {
  it('quits on q and on Ctrl-C', () => {
    expect(chars(start(), 'q').effect).toEqual({ kind: 'quit' });
    expect(press(start(), 'cancel').effect).toEqual({ kind: 'quit' });
  });

  // `v` used to cycle through fingerprints on the way, which put the mode nobody
  // asked for in front of the one they did.
  it('goes straight to real values on v, and back off', () => {
    expect(chars(start(), 'v').effect).toEqual({
      kind: 'values',
      mode: 'value',
    });
    expect(chars(start({ values: 'value' }), 'v').effect).toEqual({
      kind: 'values',
      mode: 'none',
    });
  });

  it('keeps comparing on its own key', () => {
    expect(chars(start(), 'c').effect).toEqual({
      kind: 'values',
      mode: 'fingerprint',
    });
    expect(chars(start({ values: 'fingerprint' }), 'c').effect).toEqual({
      kind: 'values',
      mode: 'none',
    });
  });

  it('switches straight between the two modes', () => {
    expect(chars(start({ values: 'fingerprint' }), 'v').effect.mode).toBe(
      'value',
    );
    expect(chars(start({ values: 'value' }), 'c').effect.mode).toBe(
      'fingerprint',
    );
  });

  // The loop has to decrypt before either mode has anything to show, so the
  // reducer asks rather than flipping the mode itself and rendering empty cells.
  it('leaves the mode alone until the loop has read the values', () => {
    expect(chars(start(), 'v').state.values).toBe('none');
  });

  it('asks for the sync', () => {
    expect(chars(start(), 's').effect).toEqual({ kind: 'sync' });
  });

  // Retired from the console. `pnpm secrets:audit` is still the audit, and still
  // what CI runs.
  it('no longer binds a for the audit', () => {
    expect(chars(start(), 'a').effect).toBeNull();
  });

  // Retired keys, pinned: the next person to reach for one should get nothing
  // rather than a surprise.
  it('no longer binds p for comparing', () => {
    expect(chars(start(), 'p').effect).toBeNull();
  });

  it('no longer binds f for the filter', () => {
    expect(chars(start(), 'f').state.filter).toBe('all');
  });

  it('no longer binds d, since there is nothing to toggle', () => {
    expect(chars(start(), 'd')).toEqual({
      state: expect.objectContaining({ pane: 'grid' }),
      effect: null,
    });
  });

  it('ignores a key it does not know', () => {
    expect(chars(start(), 'z')).toEqual({
      state: expect.objectContaining({ selected: 'api.A_REQ' }),
      effect: null,
    });
  });

  it('is case-insensitive, so Caps Lock is not a trap', () => {
    expect(chars(start(), 'Q').effect).toEqual({ kind: 'quit' });
  });
});

describe('layout', () => {
  const at = (columns, values = 'none') =>
    layout({ columns, environments: ENVIRONMENTS_THREE, values });

  // The widest reason there is measures 29 — `✗ required, not in production` — so
  // the cap is 30. It was 52, a round number that left a third of the column empty.
  it('spends a wide terminal on the reason column, up to what one needs', () => {
    expect(at(70).reason).toBe(0);
    expect(at(90).reason).toBeGreaterThan(20);
    expect(at(200).reason).toBe(30);
  });

  // `✗ required,…` tells a reader less than the glyph alone does.
  it('drops the reason column rather than leaving a stub', () => {
    expect(at(69).reason).toBe(0);
    expect(at(86).reason).toBeGreaterThanOrEqual(18);
  });

  it('gives the names whatever the reason column did not take', () => {
    expect(at(86).name).toBe(34);
    expect(at(200).name).toBe(40);
  });

  // A cell in the default view holds one glyph, and every column past the fifth
  // was blank.
  it('holds the default cells at five columns, whatever the terminal', () => {
    for (const columns of [71, 90, 120, 240]) expect(at(columns).cell).toBe(5);
  });

  it('leaves room for a fingerprint in each cell', () => {
    expect(at(160, 'fingerprint').cell).toBe(13);
    expect(at(160, 'none').cell).toBe(5);
  });

  // The cells are the point in value mode: a truncated secret is worth less the
  // shorter it is, and nothing else on the row earns the space.
  it('spends the whole terminal on the cells in value mode', () => {
    const wide = at(200, 'value');

    expect(wide.reason).toBe(0);
    expect(wide.name).toBe(34);
    expect(wide.cell).toBeGreaterThan(40);
  });

  // Fixed per-mode minimums meant a mode simply did not fit some terminals, and
  // the rows wrapped rather than the cells getting narrower.
  it('narrows the cells rather than overflowing, in every mode', () => {
    for (const mode of VALUE_MODES) {
      const narrow = at(71, mode);
      const total = 4 + narrow.name + narrow.schema + narrow.cell * 3 + 1;

      expect(total).toBeLessThanOrEqual(71);
    }
  });
});

describe('split', () => {
  const at = (columns, environments = ENVIRONMENTS_THREE) =>
    split({ columns, environments });

  // 4 gutter + 34 name + 14 schema + 1 flag + 5 per cell = 68, plus a 2 gap and the
  // pane's own 30. The floor is built from the constants `layout` uses.
  it('needs the grid floor plus a gap plus the pane', () => {
    expect(at(120).need).toBe(100);
    expect(at(100).side).toBe(30);
    expect(at(99).side).toBe(0);
  });

  it('leaves the grid whole when the pane does not fit', () => {
    expect(at(99)).toMatchObject({ grid: 99, side: 0 });
  });

  // The grid stops at what it wants — 104 with three environments — and the rest is
  // the pane's. Slack left on the grid would only sit between the last cell and the
  // pane, pushing the pane right for nothing.
  it('gives the pane everything the grid does not want', () => {
    expect(at(140)).toMatchObject({ grid: 104, side: 34 });
    expect(at(200)).toMatchObject({ grid: 104, side: 94 });
    expect(at(240)).toMatchObject({ grid: 104, side: 134 });
  });

  it('never takes the grid below its floor', () => {
    for (let columns = 100; columns <= 240; columns += 1) {
      expect(at(columns).grid).toBeGreaterThanOrEqual(68);
      expect(at(columns).grid + at(columns).side + 2).toBe(columns);
    }
  });

  // One more environment is one more cell the grid cannot give up.
  it('asks for more when there are more environments', () => {
    expect(at(120, ['local', 'staging']).need).toBe(95);
    expect(at(120, [...ENVIRONMENTS_THREE, 'preview']).need).toBe(105);
  });

  // Comparing needs thirteen columns a cell where the default view needs five, so
  // the grid keeps more of a wide terminal in that mode.
  it('leaves the grid more room when the cells want more', () => {
    expect(
      split({
        columns: 200,
        environments: ENVIRONMENTS_THREE,
        values: 'fingerprint',
      }).grid,
    ).toBeGreaterThan(at(200).grid);
  });
});

describe('the pane at the side', () => {
  const wide = { columns: 140, colors: false };
  const ESC = String.fromCharCode(27);
  const opened = () => tall();
  const drawn = (state, options) =>
    renderShell(state, { ...wide, ...options }).join('\n');

  // Open whenever it can be. Two conditions close it, and neither is a keystroke:
  // value mode, and a terminal with no room.
  it('draws by default, and only value mode or no room closes it', () => {
    expect(drawn(opened())).toContain('api.A_REQ');
    expect(drawn({ ...opened(), values: 'value' })).not.toContain(
      'DEVELOPMENT',
    );
    expect(drawn(opened(), { columns: NARROW })).not.toContain('DEVELOPMENT');
  });

  // Same facts as the panel below. Both at once is the same thing twice with half
  // the room for each, so the pane wins wherever it is drawn at all.
  it('never draws alongside the panel below', () => {
    const both = { ...opened(), detail: true };

    expect(drawn(both)).toContain('DEVELOPMENT');
    expect(drawn(both)).not.toMatch(/^ {2}scope {6}/m);
  });

  it('moves into the pane on right, and back on left', () => {
    const inPane = press(opened(), 'right').state;

    expect(inPane.pane).toBe('detail');
    expect(press(inPane, 'left').state.pane).toBe('grid');
  });

  // A cursor in a pane nobody can see would swallow the arrow keys.
  it('refuses to move into a pane that is not drawn', () => {
    expect(pressIn(opened(), 'right', NARROW).state.pane).toBe('grid');
    expect(press({ ...opened(), values: 'value' }, 'right').state.pane).toBe(
      'grid',
    );
  });

  it('moves over the environments once inside, wrapping', () => {
    let state = press(opened(), 'right').state;

    expect(state.cursor).toBe(0);
    state = press(state, 'down').state;
    expect(state.cursor).toBe(1);
    expect(press(state, 'down').state.cursor).toBe(0);
    expect(press(state, 'up').state.cursor).toBe(0);
  });

  it('leaves the grid selection alone while the pane has focus', () => {
    const inPane = press(opened(), 'right').state;
    const moved = press(press(inPane, 'down').state, 'down').state;

    expect(moved.selected).toBe(inPane.selected);
  });

  // A page is a grid verb. In the pane there are three rows and nothing to page.
  it('ignores the page and home keys inside the pane', () => {
    const inPane = press(opened(), 'right').state;

    expect(press(inPane, 'pagedown').state).toEqual(inPane);
    expect(press(inPane, 'home').state).toEqual(inPane);
  });

  it('steps out of the pane on escape, and the pane stays', () => {
    const inPane = press(opened(), 'right').state;
    const once = press(inPane, 'escape').state;

    expect(once.pane).toBe('grid');
    expect(drawn(once)).toContain('DEVELOPMENT');
  });

  // The pane being open *is* the detail being open. Requiring the panel below as
  // well would mean opening the same information twice to act on it.
  it('treats the pane as the variable being open', () => {
    const inPane = press(opened(), 'right').state;

    expect(press(inPane, 'enter').effect).toMatchObject({ kind: 'write' });
    expect(chars(opened(), 'u').effect).toMatchObject({ kind: 'unset' });
  });

  // What replaced `r`: the values are simply there, one under each environment.
  it('prints each value under its own environment, a blank line apart', () => {
    const shown = renderShell(opened(), {
      ...wide,
      cellValue: (environment) => `${environment}-value`,
    });
    const at = shown.findIndex((line) => line.includes('DEVELOPMENT'));

    expect(shown[at + 1]).toContain('local-value');
    expect(shown[at + 2].slice(94).trim()).toBe('');
    expect(shown[at + 3]).toContain('STAGING');
  });

  // `c` exists to compare without showing, and the pane would have defeated it.
  it('swaps the value for the fingerprint in compare mode', () => {
    const prints = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ENVS,
      inventories: {
        local: { api: cell(['A_DEF']) },
        staging: { api: cell(['A_DEF']) },
      },
      declarations: DECLARATIONS,
      fingerprints: { local: { api: { A_DEF: 'deadbeef' } } },
    });
    const shown = renderShell(
      {
        ...initialState({ matrix: prints, environments: ENVS }),
        values: 'fingerprint',
      },
      { ...wide, cellValue: () => 'the-secret' },
    ).join('\n');

    expect(shown).toContain('deadbeef');
    expect(shown).not.toContain('the-secret');
  });

  it('says so rather than leaving a blank when it holds no key', () => {
    const shown = renderShell(opened(), {
      ...wide,
      cellValue: () => null,
    }).join('\n');

    expect(shown).toContain('cannot decrypt');
  });

  // Beside means it shares rows with the grid rather than adding its own: the pane
  // title is on the column header's line, and nothing below the legend is the pane.
  it('draws the pane beside the grid, not below it', () => {
    const out = renderShell(opened(), wide);
    const head = out.findIndex((line) => line.includes('Variable'));
    const legend = out.findIndex((line) => line.includes('declared, not set'));

    expect(out[head]).toContain('api.A_REQ');
    expect(out.slice(legend).join(' ')).not.toContain('api.A_REQ');
  });

  it('lines the pane title up with the column header', () => {
    const withPane = renderShell(opened(), wide);
    const head = withPane.findIndex((line) => line.includes('Variable'));

    expect(withPane[head]).toContain('api.A_REQ');
  });

  // Measured off the rule, which is the one line whose length is the grid's width
  // and nothing else: every row has the pane written onto its right-hand end.
  it('narrows the grid to make room', () => {
    const ruleRun = (options) =>
      renderShell(opened(), { ...wide, ...options })
        .find((candidate) => candidate.includes(MARKS.rule.repeat(10)))
        .split('')
        .filter((character) => character === MARKS.rule).length;

    const { side } = split({ columns: 140, environments: ENVS });

    expect(ruleRun()).toBeLessThanOrEqual(140 - side - 2);
    // Past its appetite the grid stops growing and the pane takes the rest, so a
    // wider terminal no longer widens the grid.
    expect(ruleRun({ columns: 240 })).toBe(ruleRun());
  });

  // The whole word, upper-cased, and `local` reads DEVELOPMENT. Display labels:
  // the environment is still `local` in the filename and in `secrets:set`.
  it('labels the environment rows with the long names', () => {
    const withPane = renderShell(opened(), wide).join('\n');

    expect(withPane).toContain('DEVELOPMENT');
    expect(withPane).toContain('STAGING');
    expect(withPane).not.toMatch(/^ *local {5}/m);
  });

  // The banner still lists the three real names, so the one you would type is
  // never off the screen.
  it('keeps the real names where they are the thing you type', () => {
    expect(renderShell(opened(), wide)[0]).toContain('local staging');
  });

  // Each finding is a sentence that names its own environment — "in local still
  // holds a placeholder" — so a DEVELOPMENT header over a `local` body would read
  // as two different facts.
  it('leaves the findings headers on the real names', () => {
    const shown = renderShell(
      { ...opened(), selected: 'api.A_OPT', detail: true },
      { columns: NARROW },
    ).join('\n');

    expect(shown).toContain('missing-everywhere');
    expect(shown).not.toContain('— DEVELOPMENT');
  });

  // Filled on the side you are on, tinted on the other: a fill is what a cursor
  // looks like, and there is only one cursor.
  it('fills the focused row from the pane and only tints it from the grid', () => {
    const painted = (state) =>
      renderShell(state, { ...wide, colors: true }).join('\n');
    const inPane = press(opened(), 'right').state;

    expect(painted(inPane)).toMatch(
      new RegExp(`${ESC}\\[97;4[123]mDEVELOPMENT`),
    );
    expect(painted(opened())).not.toMatch(
      new RegExp(`${ESC}\\[97;4[123]mDEVELOPMENT`),
    );
    expect(painted(opened())).toMatch(
      new RegExp(`${ESC}\\[3[123]mDEVELOPMENT`),
    );
  });

  it('tints every environment row, not just the focused one', () => {
    const painted = renderShell(press(opened(), 'right').state, {
      ...wide,
      colors: true,
    }).join('\n');

    expect(painted).toMatch(new RegExp(`${ESC}\\[3[123]mSTAGING`));
  });

  // "Too narrow for what" is the only part a reader cannot work out by looking, so
  // the message carries both numbers.
  it('says what it would need when it does not fit', () => {
    const narrow = renderShell(opened(), { columns: 90 }).join(' ');

    expect(narrow).toContain('needs 95 columns');
    expect(narrow).toContain('has 90');
  });

  it('draws no pane at all when it does not fit', () => {
    expect(renderShell(opened(), { columns: 90 }).join('\n')).not.toContain(
      'api.A_REQ',
    );
  });

  // Value mode hides the pane, so the focus panel below is what shows the
  // values in full — which is the arrangement the pane was standing in for.
  it('gives the values back to the focus panel in value mode', () => {
    const shown = renderShell(
      { ...opened(), values: 'value' },
      { ...wide, cellNote: () => 'the-value' },
    ).join('\n');

    expect(shown).toMatch(new RegExp('^ {2}api\\.A_REQ$', 'm'));
    expect(shown).not.toContain('DEVELOPMENT');
  });

  it('counts what it had to leave out', () => {
    const shown = renderShell(opened(), {
      ...wide,
      slice: { start: 0, size: 1, scrolled: true },
    }).join(' ');

    expect(shown).toMatch(/\+\d+ more/);
  });

  // Value mode and a narrow terminal are the two conditions, and the message only
  // makes sense for the second: value mode is a choice the reader just made.
  it('explains itself only when the terminal is the reason', () => {
    expect(drawn(opened(), { columns: NARROW })).toContain('needs 95 columns');
    expect(drawn({ ...opened(), values: 'value' })).not.toContain(
      'needs 95 columns',
    );
  });

  // `placeholder` is a warning in `local`, where placeholders are the documented
  // convention, and an error anywhere else. Grouped by code alone, the panel
  // labelled both from whichever came first and reported the production error as a
  // warning — while the grid's own reason column had it right, so the two views of
  // one row disagreed about whether the app would boot.
  it('does not label an error as a warning when a code fires as both', () => {
    const both = {
      ...start(),
      rows: buildRows(MATRIX).map((row) =>
        row.key === 'A_DEF'
          ? {
              ...row,
              severity: 'error',
              findings: [
                {
                  code: 'placeholder',
                  severity: 'warn',
                  environment: 'local',
                  message: 'local placeholders are deliberate',
                },
                {
                  code: 'placeholder',
                  severity: 'error',
                  environment: 'staging',
                  message: 'staging still holds a placeholder',
                },
              ],
            }
          : row,
      ),
      selected: 'api.A_DEF',
    };
    // Read off the panel below, which has no height cap, so this asserts on the
    // grouping rather than on how much of the pane happened to fit.
    const shown = renderShell(
      { ...both, detail: true },
      { columns: NARROW },
    ).join('\n');

    expect(shown).toContain('error placeholder — staging');
    expect(shown).toContain('warn  placeholder — local');
  });

  // The size of the problem before the reading of it, the way the banner does for
  // the whole store.
  it('heads the findings with a rule that counts them', () => {
    const both = {
      ...opened(),
      selected: 'api.A_REQ',
      rows: buildRows(TALL).map((row) =>
        row.key === 'A_REQ'
          ? {
              ...row,
              severity: 'error',
              findings: [
                {
                  code: 'missing-required',
                  severity: 'error',
                  environment: 'staging',
                  message: 'required and missing',
                },
                {
                  code: 'placeholder',
                  severity: 'warn',
                  environment: 'local',
                  message: 'a deliberate local placeholder',
                },
              ],
            }
          : row,
      ),
    };

    expect(drawn(both)).toContain('1 error · 1 warning');
  });

  it('pluralises the count', () => {
    const many = {
      ...opened(),
      selected: 'api.A_REQ',
      rows: buildRows(TALL).map((row) =>
        row.key === 'A_REQ'
          ? {
              ...row,
              severity: 'warn',
              findings: ['drift', 'placeholder'].map((code) => ({
                code,
                severity: 'warn',
                environment: 'local',
                message: code,
              })),
            }
          : row,
      ),
    };

    expect(drawn(many)).toContain('2 warnings');
  });

  // A heading over an empty section is a line the pane cannot spare, and the
  // absence of the rule is what says the row is clean.
  it('draws no rule at all when nothing is flagged', () => {
    const clean = { ...opened(), selected: 'api.A_DEF' };

    expect(drawn(clean)).not.toMatch(/── \d/);
  });

  it('keeps the legend clear of the pane', () => {
    const legend = renderShell(opened(), wide).filter((line) =>
      line.includes('declared, not set'),
    );

    expect(legend).toHaveLength(1);
    expect(legend[0]).not.toContain('registry');
  });

  it('fills the focused environment in that cell own tone', () => {
    const inPane = press(opened(), 'right').state;
    const painted = renderShell(inPane, { columns: 140, colors: true });
    const filled = painted.filter((line) => /\[97;4[123]m/.test(line));

    // The grid's selected row, and the pane's focused environment.
    expect(filled.length).toBeGreaterThanOrEqual(2);
  });
});

describe('reasonFor', () => {
  const rows = buildRows(MATRIX);

  it('says what to do about an error, not just that there is one', () => {
    expect(reasonFor(rows[0], 2)).toBe('✗ required, not in staging');
  });

  it('counts the environments when more than one is affected', () => {
    const both = {
      ...rows[0],
      findings: [
        { code: 'missing-required', severity: 'error', environment: 'staging' },
        {
          code: 'missing-required',
          severity: 'error',
          environment: 'production',
        },
      ],
    };

    expect(reasonFor(both, 3)).toBe('✗ required, not in 2/3');
  });

  it('labels a warning', () => {
    expect(reasonFor(rows[2], 2)).toBe('⚑ declared, never set');
  });

  it('says nothing for a clean row', () => {
    expect(reasonFor(rows[1], 2)).toBe('');
  });

  it('falls back to the code for a finding it has no words for', () => {
    const odd = {
      ...rows[1],
      severity: 'error',
      findings: [{ code: 'something-new', severity: 'error' }],
    };

    expect(reasonFor(odd, 2)).toContain('something-new');
  });
});

describe('elide', () => {
  it('leaves text that fits alone', () => {
    expect(elide('short', 20)).toBe('short');
  });

  // Cutting mid-word produced `missing from 2 o`, which reads as a different
  // sentence than the one it is.
  it('cuts at a word when one is close to the edge', () => {
    expect(elide('required, not in staging', 20)).toBe('required, not in…');
  });

  it('cuts hard when no word break is near', () => {
    expect(elide('aaaaaaaaaaaaaaaaaaaaaaaa', 10)).toBe('aaaaaaaaa…');
  });

  it('keeps just the glyph when there is no column at all', () => {
    expect(elide('✗ required, not in staging', 0)).toBe('✗');
  });
});

describe('wrap', () => {
  it('breaks a sentence at spaces', () => {
    expect(wrap('one two three four', 10)).toEqual(['one two', 'three four']);
  });

  it('indents every line it produces', () => {
    expect(wrap('one two three', 12, '  ')).toEqual(['  one two', '  three']);
  });

  // A secret has no spaces, so a revealed value arrives as one word longer than
  // the terminal. Word wrapping alone would leave it on one line and it would
  // wrap anyway, uncounted.
  it('hard-breaks a word longer than the room', () => {
    const broken = wrap('x'.repeat(25), 10);

    expect(broken).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('never returns a line wider than the room', () => {
    for (const width of [20, 30, 60, 100]) {
      for (const line of wrap(
        `${'y'.repeat(200)} and some words`,
        width,
        '   ',
      )) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('colorSupport', () => {
  it('follows the terminal by default', () => {
    expect(colorSupport({ env: {}, isTTY: true })).toBe(true);
    expect(colorSupport({ env: {}, isTTY: false })).toBe(false);
  });

  // no-color.org: honoured whatever else is set.
  it('obeys NO_COLOR over everything', () => {
    expect(
      colorSupport({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }),
    ).toBe(false);
  });

  it('lets FORCE_COLOR override a pipe', () => {
    expect(colorSupport({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(
      true,
    );
    expect(colorSupport({ env: { FORCE_COLOR: '0' }, isTTY: false })).toBe(
      false,
    );
  });
});

describe('visibleWidth', () => {
  it('ignores the escapes, which occupy no columns', () => {
    const green = `${String.fromCharCode(27)}[32mabc${String.fromCharCode(27)}[0m`;

    expect(green.length).toBeGreaterThan(3);
    expect(visibleWidth(green)).toBe(3);
  });
});

describe('isComplete', () => {
  const rows = buildRows(MATRIX);
  const at = (key) => rows.find((row) => row.key === key);

  it('is true for a key set and clean in every environment', () => {
    expect(isComplete(at('A_DEF'), ENVS)).toBe(true);
  });

  it('is false when one environment is missing it', () => {
    expect(isComplete(at('A_REQ'), ENVS)).toBe(false);
  });

  it('is false when it is set nowhere', () => {
    expect(isComplete(at('A_OPT'), ENVS)).toBe(false);
  });

  it('is false for a flagged row even if it is set everywhere', () => {
    const flagged = {
      ...at('A_DEF'),
      severity: 'warn',
      findings: [{ code: 'x', severity: 'warn' }],
    };

    expect(isComplete(flagged, ENVS)).toBe(false);
  });

  it('is false for a value that is not encrypted', () => {
    const leaked = {
      ...at('A_DEF'),
      cells: {
        ...at('A_DEF').cells,
        local: { present: true, encrypted: false },
      },
    };

    expect(isComplete(leaked, ENVS)).toBe(false);
  });

  // Worth saying out loud: this is "correct as far as the store can tell".
  it('says nothing about the platform, which it cannot read', () => {
    expect(isComplete(at('A_DEF'), [...ENVS, 'production'])).toBe(false);
  });
});

describe('cellTone, through the pane', () => {
  const ESC = String.fromCharCode(27);
  const LABELS = { local: 'DEVELOPMENT', staging: 'STAGING' };
  const rows = buildRows(MATRIX);
  const toneOf = (row, environment) => {
    const state = {
      ...initialState({ matrix: TALL, environments: ENVS }),
      rows: buildRows(TALL).map((candidate) =>
        rowId(candidate) === rowId(row) ? row : candidate,
      ),
      selected: rowId(row),
    };
    const found = renderShell(state, { columns: 140, colors: true })
      .join('|')
      .match(new RegExp(`${ESC}\\[(3[123])m${LABELS[environment]}`));

    return { 31: 'red', 32: 'green', 33: 'yellow' }[found[1]];
  };

  it('is green for a cell that is set and clean', () => {
    expect(toneOf(rows[1], 'local')).toBe('green');
  });

  it('is red where a required variable is missing', () => {
    expect(toneOf(rows[0], 'staging')).toBe('red');
  });

  it('is yellow where an optional one is', () => {
    expect(toneOf(rows[2], 'local')).toBe('yellow');
  });

  // Presence alone said green for `production.api.DATABASE_URL` — set, encrypted,
  // and holding a REPLACE_ME — which is the one thing green must not say, and the
  // row was already red for it.
  it('is red for a set cell whose own environment has an error', () => {
    const placeheld = {
      ...rows[1],
      severity: 'error',
      findings: [
        {
          code: 'placeholder',
          severity: 'error',
          environment: 'staging',
          message: 'staging still holds a placeholder',
        },
      ],
    };

    expect(toneOf(placeheld, 'staging')).toBe('red');
    expect(toneOf(placeheld, 'local')).toBe('green');
  });

  it('is yellow for a set cell whose own environment has a warning', () => {
    const noted = {
      ...rows[1],
      severity: 'warn',
      findings: [
        {
          code: 'placeholder',
          severity: 'warn',
          environment: 'local',
          message: 'local placeholders are deliberate',
        },
      ],
    };

    expect(toneOf(noted, 'local')).toBe('yellow');
    expect(toneOf(noted, 'staging')).toBe('green');
  });
});

describe('rowTone', () => {
  const rows = buildRows(MATRIX);
  const at = (key) => rows.find((row) => row.key === key);

  it('is green when a variable is set and clean everywhere', () => {
    expect(rowTone(at('A_DEF'), ENVS)).toBe('green');
  });

  // The distinction that was asked for: what an app needs to boot is not a shade
  // of warning, and what it can live without is not an error.
  it('is red when a required variable is missing anywhere', () => {
    expect(rowTone(at('A_REQ'), ENVS)).toBe('red');
  });

  it('is yellow when an optional variable is missing', () => {
    expect(rowTone(at('A_OPT'), ENVS)).toBe('yellow');
  });

  // One environment short is enough: the row is a claim about all of them.
  it('is red for a required variable that only one environment lacks', () => {
    const nearly = {
      ...at('A_REQ'),
      severity: null,
      findings: [],
      cells: { local: { present: true }, staging: { present: false } },
    };

    expect(rowTone(nearly, ENVS)).toBe('red');
  });

  it('is red for a plaintext value, even set everywhere', () => {
    const leaked = {
      ...at('A_DEF'),
      cells: {
        ...at('A_DEF').cells,
        local: { present: true, encrypted: false },
      },
    };

    expect(rowTone(leaked, ENVS)).toBe('red');
  });

  it('is red for an error finding on a row that is set everywhere', () => {
    const broken = {
      ...at('A_DEF'),
      severity: 'error',
      findings: [{ code: 'undeclared', severity: 'error' }],
    };

    expect(rowTone(broken, ENVS)).toBe('red');
  });

  it('is yellow for a warning on a row that is set everywhere', () => {
    const warned = {
      ...at('A_DEF'),
      severity: 'warn',
      findings: [{ code: 'drift', severity: 'warn' }],
    };

    expect(rowTone(warned, ENVS)).toBe('yellow');
  });

  // Nothing in the code says the app needs it, so nothing here says it is broken.
  // `SENTRY_ORG` is the real case: used by a CLI, validated by no Zod schema.
  it('is yellow for a missing variable no schema declares', () => {
    const undeclared = { ...at('A_OPT'), schema: null };

    expect(rowTone(undeclared, ENVS)).toBe('yellow');
  });

  it('gives every row a tone', () => {
    for (const row of rows) {
      expect(['green', 'yellow', 'red']).toContain(rowTone(row, ENVS));
    }
  });
});

describe('renderShell', () => {
  // This block measures the grid, and the pane is drawn whenever there is room for
  // one — so it renders at a width that has none. The pane has its own block, which
  // asserts on the two together. Tests that need a wide grid pass `columns` and use
  // value mode, which hides the pane for its own reasons.
  const lines = (state, options) =>
    renderShell(state, { columns: NARROW, ...options });
  const text = (state, options) => lines(state, options).join('\n');
  /** With no pane, `⏎` opens the panel below. */
  const below = (overrides = {}) => start(overrides);

  // The marker sits in the gutter left of the names, so rows stay lined up under
  // their scope header instead of the selected one jutting out.
  it('marks the selected row and only that row', () => {
    const marked = lines(start()).filter((line) => line.includes('❯'));

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('A_REQ');
    expect(marked[0].indexOf('A_REQ')).toBe(
      lines(start())
        .find((line) => line.includes('A_DEF'))
        .indexOf('A_DEF'),
    );
  });

  // `api → api` was true and useless on every visible row: a scope only ever
  // feeds the app it is named after. Where the values are pushed is the thing
  // worth a line, and it is read from the same rule the sync applies.
  it('names where each scope is pushed, not which app it feeds', () => {
    expect(text(start())).toContain('api → railway/api');
    expect(text(start())).toContain('web → vercel/web');
  });

  it('flags the error row and the warning row differently', () => {
    const body = lines(start());
    const errorRow = body.find((line) => line.includes('A_REQ'));
    const warnRow = body.find((line) => line.includes('A_OPT'));

    expect(errorRow).toContain('✗');
    expect(warnRow).toContain('⚑');
  });

  it('shows the schema marker, which is what makes an unset cell readable', () => {
    expect(lines(start()).find((line) => line.includes('A_REQ'))).toContain(
      'req',
    );
  });

  it('counts errors and warnings in the header', () => {
    expect(text(start(), { counts: { error: 1, warn: 1 } })).toContain(
      '1 error(s) · 1 warning(s)',
    );
  });

  it('changes the key hints when the detail is open', () => {
    expect(text(start())).toContain('needs 95 columns');
    expect(text(pressIn(start(), 'enter', NARROW).state)).toContain('⏎ edit');
  });

  // Wrapped across lines rather than printed on one: the messages run past 200
  // characters, and a line the terminal wraps is a row the block did not count.
  it('shows the full finding text in the detail panel, wrapped', () => {
    const body = lines(pressIn(below(), 'enter', NARROW).state);
    const joined = body.join(' ').replace(/\s+/g, ' ');

    expect(joined).toContain('missing from staging');
    for (const line of body) expect(line.length).toBeLessThan(90);
  });

  it('says when a variable is not declared, because sync would refuse it', () => {
    const undeclared = buildMatrix({
      registry: { shared: [], api: [], web: [], admin: [] },
      environments: ENVS,
      inventories: { local: { api: cell(['SNEAKY']) }, staging: {} },
      declarations: {},
    });
    const state = pressIn(
      initialState({ matrix: undeclared, environments: ENVS }),
      'enter',
      NARROW,
    ).state;

    expect(text(state)).toMatch(/NOT declared/);
  });

  it('shows a revealed value only when one was asked for', () => {
    const opened = pressIn(below(), 'enter', NARROW).state;

    expect(text(opened)).not.toContain('the-secret');
    expect(text({ ...opened, revealed: { local: 'the-secret' } })).toContain(
      'the-secret',
    );
  });

  it('says how many rows are out of view when it has to scroll', () => {
    const scrolled = text(start(), {
      slice: { start: 1, size: 2, scrolled: true },
    });

    expect(scrolled).toContain('1 above');
    expect(scrolled).toContain('1 below');
  });

  it('shows a fingerprint in the cell when the grid has one', () => {
    const withPrints = buildMatrix({
      registry: REGISTRY,
      environments: ENVS,
      inventories: {
        local: { api: cell(['A_REQ']) },
        staging: { api: cell(['A_REQ']) },
      },
      declarations: DECLARATIONS,
      fingerprints: { local: { api: { A_REQ: 'deadbeef' } } },
    });
    const state = {
      ...initialState({ matrix: withPrints, environments: ENVS }),
      values: 'fingerprint',
    };

    expect(text(state, { meta: {}, columns: 140 })).toContain('deadbeef');
  });

  // The note comes from a function the caller supplies, never from the model:
  // `buildMatrix` holds no decrypted value and its own spec pins that with a
  // sentinel. This is what keeps that true while still showing values.
  it('takes the cell text from the caller when one is given', () => {
    const state = { ...start(), values: 'value' };
    const rendered = text(state, {
      columns: 160,
      cellNote: (environment, row) =>
        row.cells[environment].present ? `${environment}:${row.key}` : null,
    });

    expect(rendered).toContain('local:A_REQ');
    expect(rendered).toContain('staging:A_DEF');
  });

  // Nobody should be able to screen-share this without noticing.
  it('shouts the mode when real values are on screen', () => {
    const shown = text({ ...start(), values: 'value' }, { columns: 160 });
    const quiet = text(start(), { columns: 160 });

    expect(shown).toContain('SHOWING VALUES');
    expect(quiet).not.toContain('SHOWING VALUES');
  });

  // Three full values side by side fit no terminal — one DATABASE_URL is past a
  // hundred characters — so the row under the cursor is shown whole instead, and
  // moving the cursor is how you read one rather than a second keystroke.
  it('shows the selected value in full under the grid, in value mode', () => {
    const long =
      'postgresql://user:pass@host.example.com:5432/database?ssl=true';
    const shown = text(
      { ...start(), values: 'value' },
      {
        columns: 100,
        cellNote: (environment, row) =>
          row.cells[environment].present ? long : null,
      },
    );

    expect(shown).toContain('api.A_REQ');
    // Truncated in the cell, whole in the panel.
    expect(shown).toContain(long);
  });

  it('says which environments have nothing to show', () => {
    const shown = text(
      { ...start(), values: 'value' },
      { columns: 100, cellNote: () => null },
    );

    expect(shown).toContain('not set');
  });

  it('shows no focus panel outside value mode', () => {
    expect(text(start(), { columns: 100 })).not.toContain('api.A_REQ\n');
    expect(text({ ...start(), values: 'fingerprint' })).not.toMatch(
      /^ {2}api\.A_REQ$/m,
    );
  });

  // The detail panel already shows everything the focus panel would, and both at
  // once is the same thing twice.
  it('gives way to the detail panel when one is open', () => {
    const opened = press({ ...below(), values: 'value' }, 'enter').state;

    expect(text(opened, { columns: 100 })).toContain('registry');
  });

  const ESC = String.fromCharCode(27);
  const RESET = `${ESC}[0m`;
  const SGR_ALL = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
  const gridRows = (options) =>
    lines(start(), options).filter((line) =>
      /A_REQ|A_DEF|A_OPT|W_REQ/.test(line),
    );

  it('paints each row the tone its state earns', () => {
    const tones = Object.fromEntries(
      gridRows({ colors: true }).map((line) => [
        line.match(/A_REQ|A_DEF|A_OPT|W_REQ/)[0],
        line.slice(0, 12),
      ]),
    );

    // A_REQ is the selected row, so it carries a background rather than a
    // foreground — same tone, read differently.
    expect(tones.A_REQ).toContain(`${ESC}[97;41m`);
    expect(tones.A_OPT).toContain(`${ESC}[33m`);
    expect(tones.A_DEF).toContain(`${ESC}[32m`);
    expect(tones.W_REQ).toContain(`${ESC}[32m`);
  });

  // Once every row is coloured, the cursor mark is no longer the only thing
  // telling them apart, so the selected one is filled instead of tinted.
  it('fills the selected row and only that one', () => {
    const filled = gridRows({ colors: true }).filter((line) =>
      line.includes(`${ESC}[97;`),
    );

    expect(filled).toHaveLength(1);
    expect(filled[0]).toContain('A_REQ');
  });

  it('moves the fill with the cursor, keeping that row own tone', () => {
    const onGreen = lines(press(start(), 'down').state, {
      colors: true,
    }).find((line) => line.includes('A_DEF'));

    expect(onGreen).toContain(`${ESC}[97;42m`);
  });

  // A background that stops where the reason text did looks like a rendering
  // fault rather than a selection, so every row is padded to the same bar.
  it('pads every row to one width, so the fill is a bar', () => {
    const widths = new Set(
      gridRows({ colors: false }).map((line) => line.length),
    );

    expect(widths.size).toBe(1);
  });

  it('emits no escapes at all when colour is off', () => {
    expect(text(start(), { colors: false })).not.toContain(
      String.fromCharCode(27),
    );
  });

  // The whole reason colour is applied last: an escape sequence counted as
  // content would make every width in the layout wrong.
  it('does not change what a row occupies on screen', () => {
    const rows = (options) =>
      lines(start(), { ...options, columns: 120 }).filter((line) =>
        /A_REQ|A_DEF|A_OPT|W_REQ/.test(line),
      );

    // The legend does change — it gains a line naming the tones — so this
    // compares the rows, which are the lines the layout arithmetic sized.
    expect(rows({ colors: true }).map(visibleWidth)).toEqual(
      rows({ colors: false }).map((line) => line.length),
    );
  });

  // Black on white, the one bar on screen that is not a verdict about anything.
  it('fills the whole column header row, black on white', () => {
    const header = lines(start(), { colors: true }).find((line) =>
      line.includes('Variable'),
    );

    expect(header.startsWith(`${ESC}[30;107m`)).toBe(true);
    expect(header.endsWith(RESET)).toBe(true);
    // One run of colour over the line, not a span per label.
    expect(header.match(SGR_ALL)).toHaveLength(2);
  });

  it('makes the header exactly as wide as the rows under it', () => {
    const painted = lines(start(), { colors: true });
    const header = painted.find((line) => line.includes('Variable'));
    const dataRow = painted.find((line) => line.includes('A_DEF'));

    expect(visibleWidth(header)).toBe(visibleWidth(dataRow));
  });

  // Painted whole and last, so nothing inside the line had a chance to miscount:
  // every `padEnd` and `centre` there sees a plain string.
  it('leaves the header labels where they were, to the column', () => {
    const at = (colors) =>
      lines(start(), { colors }).find((line) => line.includes('Variable'));

    expect(visibleWidth(at(true))).toBe(at(false).length);
    expect(at(true).replace(SGR_ALL, '')).toBe(at(false));
  });

  // The labels used to be cut to fit, which gave `local staging prod` in one
  // window and `loca stag prod` in another. Four characters fit the narrowest cell
  // the layout can produce, so they are the same everywhere.
  it('heads the columns DEV, STG and PROD at every width', () => {
    const three = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ENVIRONMENTS_THREE,
      inventories: Object.fromEntries(
        ENVIRONMENTS_THREE.map((environment) => [
          environment,
          { api: cell(['A_DEF']) },
        ]),
      ),
      declarations: DECLARATIONS,
    });
    const state = initialState({
      matrix: three,
      environments: ENVIRONMENTS_THREE,
    });

    for (const columns of [71, 80, 120, 240]) {
      const head = lines(state, { columns })
        .find((line) => line.includes('Variable'))
        // The pane's title shares this line once there is room for one, and the
        // labels being asserted are the grid's.
        .split('  Variable')[1];

      expect(head).toContain('DEV');
      expect(head).toContain('STG');
      expect(head).toContain('PROD');
      expect(head).not.toContain('production');
    }
  });

  // Display labels only. `local` is the file, the argument and what every message
  // about a write says, and shortening it there would be a different claim.
  it('keeps the real environment names everywhere but the heading', () => {
    const shown = text(
      { ...start(), values: 'value' },
      { columns: 100, cellNote: () => null },
    );

    expect(shown).toMatch(/^ {2}local {7}/m);
  });

  it('heads an unmapped environment with its own name rather than a blank', () => {
    const odd = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ['sandbox'],
      inventories: { sandbox: { api: cell(['A_DEF']) } },
      declarations: DECLARATIONS,
    });
    const head = lines(
      initialState({ matrix: odd, environments: ['sandbox'] }),
      {
        columns: 120,
      },
    ).find((line) => line.includes('Variable'));

    expect(head).toContain('SAND');
  });

  // The scope row divides the grid into groups, so the whole line is the divider —
  // unlike the column names, which are filled per word.
  it('fills the scope row edge to edge, in the heading blue', () => {
    const scopeRow = lines(start(), { colors: true }).find((line) =>
      line.includes('→'),
    );

    expect(scopeRow.startsWith(`${ESC}[97;44m`)).toBe(true);
    expect(scopeRow.endsWith(RESET)).toBe(true);
    expect(scopeRow).toContain('api → railway/api');
  });

  it('makes the scope row exactly as wide as the rows it heads', () => {
    const painted = lines(start(), { colors: true });
    const scopeRow = painted.find((line) => line.includes('→'));
    const dataRow = painted.find((line) => line.includes('A_DEF'));

    expect(visibleWidth(scopeRow)).toBe(visibleWidth(dataRow));
  });

  // `padEnd` cannot shorten, so a scope whose destinations run long would have
  // pushed the line past the terminal. It is elided first.
  it('never lets a scope row outgrow the terminal', () => {
    for (const columns of [71, 80, 100, 240]) {
      const scopeRow = lines(start(), { colors: false, columns }).find((line) =>
        line.includes('→'),
      );

      expect(scopeRow.length).toBeLessThanOrEqual(columns);
    }
  });

  it('names all three tones in the legend, and only when colour is on', () => {
    const legend = text(start(), { colors: true });

    expect(legend).toContain('all set');
    expect(legend).toContain('optional, unset');
    expect(legend).toContain('required, unset');
    expect(text(start(), { colors: false })).not.toContain('all set');
  });

  // Centring gave three offsets in one grid: a lone `●` centred in five landed on
  // the third column, `● 7dc7e0…` began on the second, and `PROD` at four characters
  // centred one column left of `DEV`. The eye read them as columns that do not line
  // up, which is what they were. Two offsets now, each the same in all three.
  it('starts every heading and every value on its own fixed column', () => {
    const painted = lines(start(), { colors: false });
    const head = painted.find((line) => line.includes('Variable'));
    const row = painted.find((line) => line.includes('A_DEF'));
    const width = layout({ columns: 88, environments: ENVS });
    // 4 columns of gutter, then the name and schema columns.
    const from = 4 + width.name + width.schema;

    for (let cell = 0; cell < ENVS.length; cell += 1) {
      const at = from + cell * width.cell;

      // A heading starts on the cell's second column — `PROD` is four characters
      // and five leaves no later start — and a value on its third, which puts the
      // glyph under the middle letter of a three-letter heading.
      expect(head[at]).toBe(' ');
      expect(head[at + 1]).not.toBe(' ');
      expect(row.slice(at, at + 2)).toBe('  ');
      expect(row[at + 2]).toBe(MARKS.set);
    }
  });

  // Two rules with one offset: a fingerprint sits under the glyph it belongs to.
  it('starts a fingerprint on the same column as a bare glyph', () => {
    const prints = buildMatrix({
      registry: { shared: [], api: ['A_DEF'], web: [], admin: [] },
      environments: ENVS,
      inventories: {
        local: { api: cell(['A_DEF']) },
        staging: { api: cell(['A_DEF']) },
      },
      declarations: DECLARATIONS,
      fingerprints: { local: { api: { A_DEF: 'deadbeef' } } },
    });
    const state = {
      ...initialState({ matrix: prints, environments: ENVS }),
      values: 'fingerprint',
    };
    const row = lines(state, { columns: 140 }).find((line) =>
      line.includes('A_DEF'),
    );

    expect(row.indexOf(`${MARKS.set} deadbeef`)).toBe(row.indexOf(MARKS.set));
  });

  it('uses the shared glyphs rather than its own', () => {
    expect(text(start())).toContain(MARKS.set);
    expect(text(start())).toContain(MARKS.unset);
  });
});
