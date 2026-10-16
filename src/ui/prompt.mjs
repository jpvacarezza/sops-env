/**
 * Numbered menus and a masked value prompt, on `node:readline` and raw stdin.
 *
 * Zero dependencies on purpose. This repo has no prompt library and no argument
 * parser, and adding one costs ADR-0017's three-day publish floor plus a line in
 * the dependency inventory, permanently, to draw a list of numbers.
 *
 * The parsing is separated from the reading so the parts that decide anything can
 * be tested without a terminal. The parts that touch a terminal do nothing but
 * move bytes.
 */
import { createInterface } from 'node:readline';
import { decodeKeys } from './screen.mjs';
/** A numbered list. One-based, because the reader types what they see. */
export function renderMenu(items) {
  const width = String(items.length).length;

  return items.map(
    (label, index) => `  ${String(index + 1).padStart(width)}) ${label}`,
  );
}

/**
 * One choice, as a zero-based index.
 *
 * Refuses anything it cannot read rather than defaulting: the next question this
 * answer feeds is which secret to overwrite.
 */
export function parseChoice(answer, count) {
  const trimmed = String(answer).trim();

  if (trimmed === '') throw new Error('Nothing chosen.');

  // Plain digits only. `Number` also accepts `0x2`, `1e0`, `+2` and `2.0`, and
  // silently mapping those to a menu row is not reading what was typed — it is
  // guessing, on a prompt that decides which secret gets overwritten.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Expected a number from 1 to ${count}, got "${trimmed}".`);
  }

  const number = Number(trimmed);
  if (number < 1 || number > count) {
    throw new Error(`Expected a number from 1 to ${count}, got "${trimmed}".`);
  }

  return number - 1;
}

/**
 * Several choices: `1,3`, `2 3`, or `all`. Order and duplicates are discarded.
 */
export function parseMultiChoice(answer, count) {
  const trimmed = String(answer).trim();

  if (trimmed === '') throw new Error('Nothing chosen.');
  if (trimmed.toLowerCase() === 'all') {
    return [...Array(count).keys()];
  }

  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  const chosen = new Set();
  for (const part of parts) chosen.add(parseChoice(part, count));

  return [...chosen].sort((a, b) => a - b);
}

/** Yes only when it is actually yes. Anything else is no. */
export function parseConfirm(answer) {
  return /^(y|yes|s|si|sí)$/i.test(String(answer).trim());
}

/** One line of input, echoed. For choices, never for values. */
export function ask(
  question,
  { input = process.stdin, output = process.stdout } = {},
) {
  const rl = createInterface({ input, output });

  return new Promise((resolve) => {
    let answered = false;

    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });

    // On EOF readline closes without ever calling the callback, and a promise
    // that never settles lets node exit 0 with nothing done and nothing said.
    // Resolving empty pushes the failure into the parser, which explains itself.
    rl.on('close', () => {
      if (!answered) resolve('');
    });
  });
}

/**
 * A value, masked.
 *
 * Raw stdin rather than readline with `_writeToOutput` overridden, which is the
 * usual trick: that hook is private, and the failure mode if it ever changes is
 * the secret echoing into terminal scrollback. Raw mode uses only documented API,
 * so the masking cannot quietly stop working.
 */
export function readHidden(
  prompt,
  { input = process.stdin, output = process.stdout } = {},
) {
  if (!input.isTTY) {
    return Promise.reject(
      new Error(
        'Cannot mask a value when stdin is not a terminal. Use the ' +
          'non-interactive form instead: pipe the value into ' +
          '`sops-env set <environment> <scope> <KEY>`.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };

    const onData = (chunk) => {
      // Through `decodeKeys`, the same parser the grid navigates with. This used
      // to strip escape sequences with a regex of its own, and dropping only the
      // ESC byte let `[A` from an arrow key into the value — two extra asterisks
      // the operator could not account for, and a secret that silently differed
      // from what they typed. Two things that almost agree about terminal input
      // is one more than this needs.
      for (const key of decodeKeys(chunk)) {
        if (key.name === 'enter') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }

        // Raw mode delivers no signal, so cancellation is handled here or the
        // prompt cannot be escaped at all.
        if (key.name === 'cancel') {
          cleanup();
          output.write('\n');
          reject(new Error('Cancelled. Nothing was written.'));
          return;
        }

        if (key.name === 'backspace') {
          // By code point, not by UTF-16 unit: `slice(-1)` on an astral
          // character leaves a lone surrogate behind, and the value then differs
          // from what was typed in a way nothing downstream can see.
          const points = Array.from(value);
          if (points.length > 0) {
            value = points.slice(0, -1).join('');
            output.write('\b \b');
          }
          continue;
        }

        // Arrows, Home, Tab and the rest are navigation, and a value has no use
        // for them. `decodeKeys` has already made sure their bytes cannot arrive
        // here as characters.
        if (key.name !== 'char' && key.name !== 'space') continue;

        value += key.char;
        output.write('*');
      }
    };

    output.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/** Ask until the answer parses, or give up after `attempts` tries. */
export async function askUntil(
  question,
  parse,
  { attempts = 3, output = process.stdout, askOnce = ask, ...seams } = {},
) {
  let last;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const answer = await askOnce(question, { output, ...seams });
    try {
      return parse(answer);
    } catch (error) {
      last = error;
      output.write(`  ${error.message}\n`);
    }
  }

  throw last;
}
