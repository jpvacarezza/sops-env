/**
 * Copy a string to the system clipboard.
 *
 * OSC 52 first, because it is the one path that works inside a terminal
 * multiplexer and over SSH without a DISPLAY. Then the platform tools, so a
 * desktop session that ignores OSC 52 still gets the paste buffer.
 *
 * Never logs the text. The return value names the method, not the payload.
 */
import { spawnSync } from 'node:child_process';

const OSC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Commands tried after OSC 52, in order. ENOENT is not a failure. */
export const CLIPBOARD_COMMANDS = [
  ['wl-copy'],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
  ['pbcopy'],
  ['clip.exe'],
];

export function osc52(text) {
  return `${OSC}]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}${BEL}`;
}

export function copyToClipboard(
  text,
  {
    output = process.stdout,
    spawn = spawnSync,
    commands = CLIPBOARD_COMMANDS,
  } = {},
) {
  output.write(osc52(text));

  for (const [bin, args = []] of commands) {
    const result = spawn(bin, args, { input: String(text), encoding: 'utf8' });
    if (result.error) continue;
    if (result.status === 0) return { method: bin };
  }

  return { method: 'osc52' };
}
