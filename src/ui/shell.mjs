/**
 * The state machine behind `sops-env`, and its rendering. Both pure.
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
 *
 * The implementation is split by layer: `shell-layout.mjs` (geometry),
 * `shell-state.mjs` (the reducer) and `shell-render.mjs` (painting). This file
 * is the one import path the console loop and the specs use.
 */

export {
  COLUMN_GAP,
  SCHEMA_GAP,
  REASON_WIDTH,
  columnWidths,
  layout,
  split,
} from './shell-layout.mjs';
export {
  CELL_ACTIONS,
  CELL_STATUS,
  CELL_NOTICE,
  isComplete,
  rowId,
  buildRows,
  visibleRows,
  selectedIndex,
  selectedRow,
  VALUE_MODES,
  initialState,
  reduce,
  needsReload,
  paneVisible,
  HELP,
} from './shell-state.mjs';
export {
  colorSupport,
  visibleWidth,
  rowTone,
  selectedTone,
  wrap,
  spread,
  renderFooter,
  reasonFor,
  elide,
  renderShell,
  overlayBlock,
  cellTone,
} from './shell-render.mjs';
