import { describe, expect, it } from 'vitest';

import { CLIPBOARD_COMMANDS, copyToClipboard, osc52 } from './clipboard.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('osc52', () => {
  it('encodes the payload as base64 and never includes the plaintext', () => {
    const sequence = osc52('secret-value');

    expect(sequence.startsWith(`${ESC}]52;c;`)).toBe(true);
    expect(sequence.endsWith(BEL)).toBe(true);
    expect(sequence).not.toContain('secret-value');
    expect(sequence).toContain(
      Buffer.from('secret-value', 'utf8').toString('base64'),
    );
  });
});

describe('copyToClipboard', () => {
  it('always writes OSC 52, then reports the first successful tool', () => {
    const chunks = [];
    const spawn = (bin) =>
      bin === 'xclip'
        ? { status: 0 }
        : { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) };

    const result = copyToClipboard('payload', {
      output: { write: (chunk) => chunks.push(chunk) },
      spawn,
    });

    expect(chunks).toEqual([osc52('payload')]);
    expect(result).toEqual({ method: 'xclip' });
  });

  it('falls back to osc52 when every tool is missing', () => {
    const spawn = () => ({
      error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
    });

    expect(
      copyToClipboard('payload', {
        output: { write() {} },
        spawn,
        commands: CLIPBOARD_COMMANDS,
      }),
    ).toEqual({ method: 'osc52' });
  });

  it('does not treat a non-zero exit as success', () => {
    const spawn = () => ({ status: 1, error: undefined });

    expect(
      copyToClipboard('payload', {
        output: { write() {} },
        spawn,
        commands: [['wl-copy']],
      }),
    ).toEqual({ method: 'osc52' });
  });
});
