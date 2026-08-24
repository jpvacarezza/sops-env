/**
 * Terminal input and output for a redrawing block.
 *
 * Two jobs, both small and both testable without a terminal: turn raw bytes into
 * named keys, and reprint a block of lines in place.
 *
 * In place by rewinding the cursor, not by clearing the screen. An alternate
 * screen buffer destroys the scrollback, and comparing two renderings of the grid
 * by scrolling up is how this gets used — that trade is the reason a full-screen
 * TUI was not built.
 *
 * The cursor moves through `node:readline`'s own `moveCursor` / `clearScreenDown`
 * rather than escape codes written by hand. They are public API, they are what
 * readline itself uses, and Node owns the platform differences — which matters
 * here because the only thing verified about VT *output* on this machine is that
 * nobody has verified it.
 */
import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const ESC = String.fromCharCode(27);
const DELETE = String.fromCharCode(127);

/** CSI final bytes we care about, and what each one means. */
const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
};

/**
 * Raw bytes to named keys.
 *
 * `prompt.mjs` had a regex that *discarded* escape sequences, because a secret
 * has no use for an arrow key. This is the same parser reading them instead, and
 * `readHidden` now shares it: two things that almost agree about what terminal
 * input means is one more than this needs.
 *
 * Anything unrecognised is dropped rather than guessed at. A half-read sequence
 * arriving as `char` would land in a value or move a cursor somewhere nobody asked.
 */
export function decodeKeys(chunk) {
  const text = String(chunk);
  const keys = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character === ESC) {
      // CSI: ESC [ params final. Also covers ESC O P for some keypads, which we
      // do not use but must not leak through as characters.
      const rest = text.slice(index + 1);
      const csi = /^[[O]([0-9;]*)([A-Za-z~])/.exec(rest);

      if (!csi) {
        keys.push({ name: 'escape' });
        index += 1;
        continue;
      }

      const [matched, params, final] = csi;
      keys.push({
        name: CSI_KEYS[`${params}${final}`] ?? CSI_KEYS[final] ?? null,
      });
      index += 1 + matched.length;
      continue;
    }

    index += 1;

    if (character === '\r' || character === '\n') {
      keys.push({ name: 'enter' });
      continue;
    }
    if (character === CTRL_C || character === CTRL_D) {
      keys.push({ name: 'cancel' });
      continue;
    }
    if (character === DELETE || character === '\b') {
      keys.push({ name: 'backspace' });
      continue;
    }
    if (character === ' ') {
      keys.push({ name: 'space', char: ' ' });
      continue;
    }
    if (character === '\t') {
      keys.push({ name: 'tab' });
      continue;
    }
    if (character < ' ') continue;

    keys.push({ name: 'char', char: character });
  }

  return keys.filter((key) => key.name !== null);
}

/**
 * How many rows of a list fit, and which slice of it to show.
 *
 * `process.stdout.rows` is `undefined` whenever stdout is not a terminal, so the
 * fallback is not decoration. With 34 variables plus scope headers plus the
 * chrome, an 80x24 terminal cannot show the whole list, and the alternative to a
 * viewport is a block taller than the screen — which scrolls the rewind target
 * out of reach and turns every keypress into garbage.
 */
export function viewport(
  total,
  cursor,
  { height, chrome = 0, fallbackHeight = 24 } = {},
) {
  const rows = Math.max(1, (height ?? fallbackHeight) - chrome);
  const size = Math.min(total, rows);

  if (total <= size) return { start: 0, size: total, scrolled: false };

  // Keep the cursor inside the window, and keep the window inside the list.
  let start = Math.min(
    Math.max(0, cursor - Math.floor(size / 2)),
    total - size,
  );
  start = Math.max(0, start);

  return { start, size, scrolled: true };
}

/**
 * Render a block that is guaranteed to fit on screen, by measuring rather than
 * guessing.
 *
 * A fixed `chrome` allowance was wrong in both directions: scope headers, the
 * "N above" markers and the detail panel all change the overhead, and at one
 * terminal height it produced a block exactly as tall as the screen. Reserving
 * space (see `paint`) keeps a fitting block anchored, but nothing can rescue a
 * block taller than the terminal — so this shrinks the row window until the
 * rendered result actually fits, then truncates as a last resort so the
 * invariant always holds.
 */
export function fitBlock({
  total,
  cursor,
  height,
  render,
  fallbackHeight = 24,
  attempts = 6,
}) {
  const rows = height ?? fallbackHeight;
  // One row of headroom, because the block is written with a trailing newline
  // and the cursor has to land somewhere.
  const limit = Math.max(1, rows - 1);

  let slice = viewport(total, cursor, { height: rows });
  let lines = render(slice);

  for (
    let attempt = 0;
    attempt < attempts && lines.length > limit;
    attempt += 1
  ) {
    const next = Math.max(1, slice.size - (lines.length - limit));
    if (next === slice.size) break;
    slice = viewport(total, cursor, { height: next });
    lines = render(slice);
  }

  if (lines.length > limit) {
    lines = [
      ...lines.slice(0, limit - 1),
      `  (${lines.length - limit + 1} more lines than this terminal has room for)`,
    ];
  }

  return { lines, slice };
}

/**
 * A block of lines that can be reprinted in place.
 *
 * Tracks how many lines it last wrote, because that count is the only thing the
 * rewind can be based on: the terminal will not say where it is, and guessing
 * eats whatever was above.
 */
export function createScreen({
  output = process.stdout,
  input = process.stdin,
} = {}) {
  let painted = 0;

  return {
    get painted() {
      return painted;
    },

    /** Replace the previous block with these lines. */
    paint(lines) {
      if (painted > 0) {
        moveCursor(output, 0, -painted);
        cursorTo(output, 0);
        clearScreenDown(output);
      }

      // Make room for the whole block *before* drawing any of it, by pushing
      // blank lines down and coming straight back up.
      //
      // Without this the block scrolls the terminal as it is written, the first
      // lines go into the scrollback, and every later rewind clamps at the top of
      // the screen instead of reaching the start of the block — leaving one stale
      // line behind per repaint. That is not hypothetical: the block landed at
      // exactly the terminal height, started below a shell banner, and six
      // keypresses left six copies of the header on screen.
      //
      // Scroll-safe by construction: if writing the newlines scrolls by S rows,
      // the cursor ends at the bottom edge and the block's start has moved up by
      // the same S, so moving up `count` still lands on it.
      output.write('\n'.repeat(lines.length));
      moveCursor(output, 0, -lines.length);
      cursorTo(output, 0);

      output.write(`${lines.join('\n')}\n`);
      painted = lines.length;
    },

    /**
     * Leave the block where it is and stop tracking it, so the next paint starts
     * below instead of eating it. Used before printing something that has to
     * stay — a diff, an audit, an error.
     */
    release() {
      painted = 0;
    },

    /** Print outside the block, without disturbing the rewind count. */
    write(text) {
      output.write(text);
    },

    /** Raw mode on, and a promise per key. Restores what it found. */
    keys() {
      const wasRaw = input.isRaw;
      let queue = [];
      let waiting = null;

      const onData = (chunk) => {
        for (const key of decodeKeys(chunk)) {
          if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve(key);
          } else {
            queue.push(key);
          }
        }
      };

      input.setEncoding('utf8');
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);

      return {
        next() {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        close() {
          input.removeListener('data', onData);
          input.setRawMode(Boolean(wasRaw));
          input.pause();
          queue = [];
          waiting = null;
        },
      };
    },
  };
}
