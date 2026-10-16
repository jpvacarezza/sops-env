import { describe, expect, it } from 'vitest';

import { EventEmitter } from 'node:events';

import {
  ask,
  askUntil,
  parseChoice,
  parseConfirm,
  parseMultiChoice,
  readHidden,
  renderMenu,
} from './prompt.mjs';

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const DELETE = String.fromCharCode(127);

/** A terminal that types `keys`, one chunk at a time, and records what it saw. */
function fakeTty(keys) {
  const input = new EventEmitter();
  let written = '';

  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setEncoding: () => input,
    setRawMode: () => input,
    resume: () => {
      // Deliver on the next tick, after the caller has attached its listener.
      queueMicrotask(() => {
        for (const chunk of keys) input.emit('data', chunk);
      });
      return input;
    },
    pause: () => input,
  });

  return {
    input,
    output: {
      write: (chunk) => {
        written += String(chunk);
        return true;
      },
    },
    get written() {
      return written;
    },
  };
}

describe('renderMenu', () => {
  it('numbers from one, because that is what the reader types', () => {
    expect(renderMenu(['api', 'web'])).toEqual(['  1) api', '  2) web']);
  });

  it('right-aligns the numbers so ten items still line up', () => {
    const menu = renderMenu(Array.from({ length: 10 }, (_, i) => `item${i}`));

    expect(menu[0]).toBe('   1) item0');
    expect(menu[9]).toBe('  10) item9');
  });
});

describe('parseChoice', () => {
  it('maps the typed number to a zero-based index', () => {
    expect(parseChoice('2', 3)).toBe(1);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseChoice('  3 ', 3)).toBe(2);
  });

  it('refuses an empty answer by name', () => {
    expect(() => parseChoice('', 3)).toThrow(/Nothing chosen/);
  });

  // The next question this answer feeds is which secret to overwrite, so a
  // default here would be a guess about production. Every message is pinned:
  // a bare toThrow() would pass on any error, including the wrong one.
  it.each([
    ['a word', 'api'],
    ['zero', '0'],
    ['past the end', '4'],
    ['a fraction', '1.5'],
    ['a negative', '-1'],
    // Number() accepts all four of these. Mapping them to a row is guessing.
    ['hexadecimal', '0x2'],
    ['exponent notation', '1e0'],
    ['a signed number', '+2'],
    ['a trailing zero', '2.0'],
    ['whitespace inside', '1 2'],
  ])('refuses %s, saying what range it wanted', (_label, answer) => {
    expect(() => parseChoice(answer, 3)).toThrow(/from 1 to 3/);
  });
});

describe('parseMultiChoice', () => {
  it('reads a comma-separated list', () => {
    expect(parseMultiChoice('1,3', 3)).toEqual([0, 2]);
  });

  it('reads a space-separated list too', () => {
    expect(parseMultiChoice('1 3', 3)).toEqual([0, 2]);
  });

  it('reads `all`, whatever the case', () => {
    expect(parseMultiChoice('ALL', 3)).toEqual([0, 1, 2]);
  });

  it('discards duplicates and sorts, so the write order is stable', () => {
    expect(parseMultiChoice('3,1,3', 3)).toEqual([0, 2]);
  });

  it('refuses the whole answer when one entry is bad', () => {
    expect(() => parseMultiChoice('1,9', 3)).toThrow(/from 1 to 3/);
  });

  it('refuses an empty answer', () => {
    expect(() => parseMultiChoice('   ', 3)).toThrow(/Nothing chosen/);
  });
});

describe('parseConfirm', () => {
  it.each(['y', 'Y', 'yes', 'YES', 's', 'si', 'sí'])('accepts %s', (answer) => {
    expect(parseConfirm(answer)).toBe(true);
  });

  // Anything unrecognised is no. The alternative is writing to production
  // because someone pressed enter.
  it.each(['', 'n', 'no', 'maybe', 'yep', 'ok'])(
    'treats %s as no',
    (answer) => {
      expect(parseConfirm(answer)).toBe(false);
    },
  );
});

describe('readHidden', () => {
  it('refuses when stdin is not a terminal, and points at the piped form', async () => {
    await expect(readHidden('> ', { input: { isTTY: false } })).rejects.toThrow(
      /pnpm secrets:set/,
    );
  });

  it('reads a line and masks every character', async () => {
    const tty = fakeTty(['s3cret', '\r']);

    await expect(readHidden('> ', tty)).resolves.toBe('s3cret');
    expect(tty.written).toContain('******');
    expect(tty.written).not.toContain('s3cret');
  });

  // The defect this pins: dropping only the ESC byte left `[A` in the value,
  // and the operator saw two asterisks they could not account for.
  it('drops an arrow key instead of putting it in the secret', async () => {
    const tty = fakeTty(['ab', `${ESC}[A`, 'cd', '\r']);

    await expect(readHidden('> ', tty)).resolves.toBe('abcd');
  });

  it('drops a bracketed-paste marker too', async () => {
    const tty = fakeTty([`${ESC}[200~`, 'pasted', `${ESC}[201~`, '\r']);

    await expect(readHidden('> ', tty)).resolves.toBe('pasted');
  });

  it('erases a whole code point on backspace, not half a surrogate pair', async () => {
    const tty = fakeTty(['a\u{1F600}', DELETE, 'b', '\r']);

    await expect(readHidden('> ', tty)).resolves.toBe('ab');
  });

  it('does nothing on backspace at the start', async () => {
    const tty = fakeTty([DELETE, 'x', '\r']);

    await expect(readHidden('> ', tty)).resolves.toBe('x');
  });

  // Raw mode delivers no signal, so the prompt has to be escapable itself.
  it('rejects on Ctrl-C and says nothing was written', async () => {
    const tty = fakeTty(['abc', CTRL_C]);

    await expect(readHidden('> ', tty)).rejects.toThrow(/Nothing was written/);
  });

  it('restores raw mode and stops listening when it is done', async () => {
    const tty = fakeTty(['x', '\r']);
    let raw = null;
    tty.input.setRawMode = (value) => {
      raw = value;
      return tty.input;
    };

    await readHidden('> ', tty);

    expect(raw).toBe(false);
    expect(tty.input.listenerCount('data')).toBe(0);
  });
});

describe('ask', () => {
  // On EOF readline closes without calling the question callback. A promise that
  // never settles let node exit 0 having written nothing and said nothing.
  it('resolves empty on EOF rather than hanging forever', async () => {
    const input = new EventEmitter();
    Object.assign(input, {
      readable: true,
      resume: () => input,
      pause: () => input,
      setEncoding: () => input,
    });
    const promise = ask('> ', { input, output: { write: () => true } });
    queueMicrotask(() => input.emit('end'));

    await expect(promise).resolves.toBe('');
  });
});

describe('askUntil', () => {
  const scripted = (answers) => {
    const written = [];
    let index = 0;

    return {
      written,
      options: {
        output: { write: (chunk) => written.push(String(chunk)) },
        askOnce: () => Promise.resolve(answers[index++]),
      },
    };
  };

  it('re-asks on a bad answer and says what was wrong', async () => {
    const { written, options } = scripted(['nine', '2']);

    await expect(
      askUntil('> ', (answer) => parseChoice(answer, 3), options),
    ).resolves.toBe(1);
    expect(written.join('')).toMatch(/from 1 to 3/);
  });

  it('gives up after the last attempt and throws the parser error', async () => {
    const { options } = scripted(['a', 'b', 'c']);

    await expect(
      askUntil('> ', (answer) => parseChoice(answer, 3), {
        ...options,
        attempts: 3,
      }),
    ).rejects.toThrow(/from 1 to 3/);
  });

  it('still asks once when told to allow no retries', async () => {
    const { options } = scripted(['2']);

    await expect(
      askUntil('> ', (answer) => parseChoice(answer, 3), {
        ...options,
        attempts: 0,
      }),
    ).resolves.toBe(1);
  });
});
