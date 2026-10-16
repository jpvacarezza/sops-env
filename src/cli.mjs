/**
 * `sops-env [--config <file>] [<command>] [args…]`. No command opens the grid.
 *
 * The config is loaded once, here, and handed to the command. Nothing below this
 * file reads `process.cwd()` or walks the tree for a config.
 */
import { loadConfig as defaultLoadConfig } from './config/load.mjs';
import * as audit from './commands/audit.mjs';
import * as check from './commands/check.mjs';
import * as edit from './commands/edit.mjs';
import * as init from './commands/init.mjs';
import * as list from './commands/list.mjs';
import * as materialize from './commands/materialize.mjs';
import * as run from './commands/run.mjs';
import * as set from './commands/set.mjs';
import * as sync from './commands/sync.mjs';
import * as unset from './commands/unset.mjs';
import * as grid from './ui/console.mjs';

export const COMMANDS = {
  init: { main: init.main, summary: 'write .sops.yaml from age public keys' },
  edit: { main: edit.main, summary: 'open one environment in sops' },
  set: { main: set.main, summary: 'write one variable (value on stdin)' },
  unset: { main: unset.main, summary: 'remove one variable' },
  run: { main: run.main, summary: "run a command with one app's projection" },
  materialize: {
    main: materialize.main,
    summary: "write an app's dotenv file",
  },
  sync: { main: sync.main, summary: 'push an environment to its platforms' },
  check: {
    main: check.main,
    summary: 'ciphertext structure; --decrypt projects too',
  },
  list: { main: list.main, summary: 'the grid, as text or --json' },
  audit: {
    main: audit.main,
    summary: 'values, pairs, placeholders, schemas; fails',
  },
};

export const USAGE = `Usage: sops-env <command> [args…]
       sops-env                 the navigable grid (needs a terminal)

Commands
  ${Object.entries(COMMANDS)
    .map(([name, { summary }]) => `${name.padEnd(12)}${summary}`)
    .join('\n  ')}

Options
  --config <file>  secrets.config.mjs to use (default: nearest one above cwd, or $SOPS_ENV_CONFIG)
  --help           this text; <command> --help for a command's own

Config: secrets.config.mjs at the repository root. Documentation: README.md.`;

export function parseGlobal(argv) {
  let config;
  let help = false;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (positional.length === 0 && arg === '--config') {
      config = argv[index + 1];
      if (config === undefined || config.startsWith('--'))
        throw new Error('--config needs a path.');
      index += 1;
    } else if (positional.length === 0 && (arg === '--help' || arg === '-h')) {
      help = true;
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { config, help, command, rest };
}

export async function main(
  argv,
  {
    loadConfig = defaultLoadConfig,
    commands = COMMANDS,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  let global;
  try {
    global = parseGlobal(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (global.help && global.command === '') {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const command = global.command === '' ? grid : commands[global.command];
  if (!command) {
    stderr.write(
      `Unknown command "${global.command}". Expected one of: ${Object.keys(commands).join(', ')}.\n\n${USAGE}\n`,
    );
    return 2;
  }

  let ctx;
  try {
    ctx = await loadConfig({
      cwd,
      file: global.config ?? process.env.SOPS_ENV_CONFIG,
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  // Commands print through console.log/console.error. When a caller (a test)
  // hands in its own streams, route the console there for the dispatch.
  const restore = redirectConsole(stdout, stderr);
  try {
    return await command.main(
      ctx,
      global.help ? [...global.rest, '--help'] : global.rest,
    );
  } finally {
    restore();
  }
}

function redirectConsole(stdout, stderr) {
  if (stdout === process.stdout && stderr === process.stderr) return () => {};
  const { log, error } = console;
  console.log = (...args) => stdout.write(`${args.join(' ')}\n`);
  console.error = (...args) => stderr.write(`${args.join(' ')}\n`);
  return () => Object.assign(console, { log, error });
}
