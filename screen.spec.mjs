import { describe, expect, it } from 'vitest';

import { createScreen, decodeKeys, fitBlock, viewport } from './screen.mjs';

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const DELETE = String.fromCharCode(127);

const names = (chunk) => decodeKeys(chunk).map((key) => key.name);

function fakeOutput() {
  let written = '';
  return {
    write: (chunk) => {
      written += String(chunk);
      return true;
    },
    get text() {
      return written;
    },
    clear() {
      written = '';
    },
  };
}

describe('decodeKeys', () => {
  it.each([
    ['up', 'A'],
    ['down', 'B'],
    ['right', 'C'],
    ['left', 'D'],
    ['home', 'H'],
    ['end', 'F'],
  ])('reads %s from a CSI sequence', (name, final) => {
    expect(names(`${ESC}[${final}`)).toEqual([name]);
  });

  it('reads page up and page down, which carry a parameter', () => {
    expect(names(`${ESC}[5~${ESC}[6~`)).toEqual(['pageup', 'pagedown']);
  });

  it('reads an arrow that arrives with a modifier parameter', () => {
    expect(names(`${ESC}[1;5A`)).toEqual(['up']);
  });

  it.each([
    ['enter', '\r'],
    ['enter', '\n'],
    ['cancel', CTRL_C],
    ['cancel', CTRL_D],
    ['backspace', DELETE],
    ['backspace', '\b'],
    ['space', ' '],
    ['tab', '\t'],
  ])('reads %s', (name, byte) => {
    expect(names(byte)).toEqual([name]);
  });

  it('reads a bare escape as escape', () => {
    expect(names(ESC)).toEqual(['escape']);
  });

  it('carries the character for a printable key', () => {
    expect(decodeKeys('q')).toEqual([{ name: 'char', char: 'q' }]);
  });

  // The reason this parser exists rather than the regex that used to discard
  // these: `[A` leaking through as two characters is how an arrow key ended up
  // inside a secret.
  it('never lets a CSI body through as characters', () => {
    expect(decodeKeys(`${ESC}[A`).every((key) => key.name !== 'char')).toBe(
      true,
    );
    expect(names(`ab${ESC}[Acd`)).toEqual([
      'char',
      'char',
      'up',
      'char',
      'char',
    ]);
  });

  it('drops a bracketed-paste marker rather than moving anything', () => {
    expect(names(`${ESC}[200~x${ESC}[201~`)).toEqual(['char']);
  });

  it('reads several keys out of one chunk, in order', () => {
    expect(names(`j${ESC}[B\r`)).toEqual(['char', 'down', 'enter']);
  });

  it('drops the remaining control bytes', () => {
    expect(names(String.fromCharCode(1, 2, 11, 12))).toEqual([]);
  });
});

describe('viewport', () => {
  it('shows everything when it fits', () => {
    expect(viewport(10, 0, { height: 40, chrome: 10 })).toEqual({
      start: 0,
      size: 10,
      scrolled: false,
    });
  });

  it('scrolls and keeps the cursor in the middle of the window', () => {
    const window = viewport(40, 20, { height: 20, chrome: 10 });

    expect(window.scrolled).toBe(true);
    expect(window.size).toBe(10);
    expect(20).toBeGreaterThanOrEqual(window.start);
    expect(20).toBeLessThan(window.start + window.size);
  });

  it('clamps at the top', () => {
    expect(viewport(40, 0, { height: 20, chrome: 10 }).start).toBe(0);
  });

  it('clamps at the bottom, so the last row is reachable', () => {
    const window = viewport(40, 39, { height: 20, chrome: 10 });

    expect(window.start + window.size).toBe(40);
  });

  // `process.stdout.rows` is undefined whenever stdout is not a terminal, so
  // this fallback is load-bearing rather than decorative.
  it('falls back when the height is unknown', () => {
    expect(viewport(40, 0, { height: undefined, chrome: 10 }).size).toBe(14);
  });

  it('never returns a window of zero rows, however small the terminal', () => {
    expect(viewport(40, 0, { height: 4, chrome: 10 }).size).toBe(1);
  });
});

describe('fitBlock', () => {
  /** `size` rows plus a fixed overhead, the shape renderShell has. */
  const renderer = (overhead) => (slice) =>
    Array.from(
      { length: slice.size + overhead },
      (_, index) => `line ${index}`,
    );

  // The bug this exists for: a fixed chrome allowance produced a block exactly as
  // tall as the terminal, which scrolls it, which puts the top out of the
  // cursor's reach — one stale line left behind per repaint, forever.
  it.each([8, 12, 20, 24, 30, 36, 40, 50, 60])(
    'never returns more lines than a %i-row terminal can hold',
    (height) => {
      const { lines } = fitBlock({
        total: 34,
        cursor: 3,
        height,
        render: renderer(9),
      });

      expect(lines.length).toBeLessThanOrEqual(height - 1);
    },
  );

  it('shrinks the row window rather than cutting lines off', () => {
    const { lines, slice } = fitBlock({
      total: 34,
      cursor: 0,
      height: 20,
      render: renderer(9),
    });

    expect(slice.size).toBeLessThan(34);
    expect(lines[lines.length - 1]).toMatch(/^line /);
  });

  it('shows everything when it all fits', () => {
    const { slice } = fitBlock({
      total: 5,
      cursor: 0,
      height: 40,
      render: renderer(9),
    });

    expect(slice.size).toBe(5);
  });

  // A detail panel taller than the terminal cannot be shrunk away, and a block
  // taller than the screen breaks every later redraw — so it gets cut, and says so.
  it('truncates with a marker when even one row does not fit', () => {
    const { lines } = fitBlock({
      total: 34,
      cursor: 0,
      height: 6,
      render: renderer(40),
    });

    expect(lines.length).toBe(5);
    expect(lines[lines.length - 1]).toMatch(/more lines than this terminal/);
  });

  it('falls back when the terminal height is unknown', () => {
    const { lines } = fitBlock({
      total: 34,
      cursor: 0,
      height: undefined,
      render: renderer(9),
    });

    expect(lines.length).toBeLessThanOrEqual(23);
  });
});

describe('createScreen', () => {
  it('writes the lines and remembers how many', () => {
    const output = fakeOutput();
    const screen = createScreen({ output });

    screen.paint(['a', 'b', 'c']);

    expect(output.text).toContain('a\nb\nc\n');
    expect(screen.painted).toBe(3);
  });

  // Without this the block scrolls the terminal as it is drawn, its first lines
  // go into the scrollback, and every later rewind clamps at the top of the
  // screen — one stale line per repaint. Measured: six keypresses, six headers.
  it('makes room for the whole block before drawing any of it', () => {
    const output = fakeOutput();

    createScreen({ output }).paint(['a', 'b', 'c']);

    const reserve = output.text.indexOf('\n\n\n');
    const rewind = output.text.indexOf(`${ESC}[3A`);
    const body = output.text.indexOf('a\nb\nc');

    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(rewind).toBeGreaterThan(reserve);
    expect(body).toBeGreaterThan(rewind);
  });

  // Rewinding is what keeps the scrollback, which is the whole reason this is
  // not a full-screen TUI.
  it('rewinds by the number of lines it last wrote', () => {
    const output = fakeOutput();
    const screen = createScreen({ output });

    screen.paint(['a', 'b', 'c']);
    output.clear();
    screen.paint(['d']);

    expect(output.text).toContain(`${ESC}[3A`);
    expect(output.text).toContain('d');
    expect(screen.painted).toBe(1);
  });

  // The reserve step does move the cursor on the first paint, but it never
  // clears: whatever the shell printed above has to survive, which is the whole
  // reason this is not an alternate screen buffer.
  it('erases nothing on the first paint', () => {
    const output = fakeOutput();

    createScreen({ output }).paint(['a']);

    expect(output.text).not.toContain(`${ESC}[0J`);
  });

  // Used before printing something that has to stay — a diff, an audit, an error.
  it('stops tracking the block on release, so the next paint lands below it', () => {
    const output = fakeOutput();
    const screen = createScreen({ output });

    screen.paint(['a', 'b']);
    screen.release();
    output.clear();
    screen.paint(['c']);

    expect(screen.painted).toBe(1);
    expect(output.text).not.toContain(`${ESC}[2A`);
  });

  it('writes outside the block without disturbing the rewind count', () => {
    const output = fakeOutput();
    const screen = createScreen({ output });

    screen.paint(['a', 'b']);
    screen.write('note\n');

    expect(screen.painted).toBe(2);
  });
});
