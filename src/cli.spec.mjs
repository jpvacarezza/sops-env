import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_CONFIG_FILE,
  FIXTURE_ROOT,
  withFixtureKey,
} from '../test/helpers/ctx.mjs';
import { COMMANDS, main, parseGlobal } from './cli.mjs';

const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
};

describe('parseGlobal', () => {
  it('splits --config and --help from the command and its argv', () => {
    expect(
      parseGlobal(['--config', 'x.mjs', 'list', '--json', 'local']),
    ).toEqual({
      config: 'x.mjs',
      help: false,
      command: 'list',
      rest: ['--json', 'local'],
    });
    expect(parseGlobal(['--help'])).toEqual({
      config: undefined,
      help: true,
      command: '',
      rest: [],
    });
    expect(parseGlobal([])).toEqual({
      config: undefined,
      help: false,
      command: '',
      rest: [],
    });
  });

  it('refuses --config without a path', () => {
    expect(() => parseGlobal(['--config'])).toThrow(/--config needs a path/);
  });
});

describe('main', () => {
  it('prints usage and exits 0 on --help without loading a config', async () => {
    const io = capture();
    const code = await main(['--help'], {
      ...io,
      loadConfig: () => {
        throw new Error('must not load');
      },
    });

    expect(code).toBe(0);
    expect(io.out.join('')).toMatch(/Usage: sops-env <command>/);
    for (const name of Object.keys(COMMANDS))
      expect(io.out.join('')).toMatch(new RegExp(`^  ${name} `, 'm'));
  });

  it('exits 2 and names the command on an unknown one', async () => {
    const io = capture();
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.err.join('')).toMatch(
      /Unknown command "frobnicate"\. Expected one of: init, edit, set, unset, run, materialize, sync, check, list, audit/,
    );
  });

  describe('a command that throws', () => {
    const boom = {
      boom: {
        main: async () => {
          throw new Error('projectEnv: invalid document');
        },
        summary: 'throws',
      },
    };
    const run = async (options) => {
      const io = capture();
      const code = await main(['boom'], {
        ...io,
        commands: boom,
        loadConfig: async () => ({}),
        ...options,
      });
      return { code, err: io.err.join('') };
    };

    it('exits 1 with the message and no stack trace', async () => {
      const { code, err } = await run({ env: {} });

      expect(code).toBe(1);
      expect(err).toBe('projectEnv: invalid document\n');
    });

    it('prints the stack when SOPS_ENV_DEBUG is set', async () => {
      const { code, err } = await run({ env: { SOPS_ENV_DEBUG: '1' } });

      expect(code).toBe(1);
      expect(err).toMatch(/projectEnv: invalid document\n\s+at /);
    });
  });

  // Review Focus 5.
  it('exits 1 with the config error, no stack trace, when no config is found', async () => {
    const io = capture();
    const code = await main(['list'], {
      ...io,
      cwd: fileURLToPath(new URL('../', import.meta.url)),
    });

    expect(code).toBe(1);
    expect(io.err.join('')).toMatch(
      /No secrets\.config\.mjs found walking up from .*SOPS_ENV_CONFIG/,
    );
    expect(io.err.join('')).not.toMatch(/\n\s+at /);
  });

  it('dispatches with the loaded ctx and the remaining argv', async () => {
    const io = capture();
    const seen = [];
    const commands = {
      list: {
        main: (ctx, argv) => {
          seen.push([ctx.root, argv]);
          return 7;
        },
      },
    };
    const code = await main(
      ['--config', FIXTURE_CONFIG_FILE, 'list', '--json'],
      { ...io, commands },
    );

    expect(code).toBe(7);
    expect(seen).toEqual([[FIXTURE_ROOT, ['--json']]]);
  });

  it('runs the real check command against the fixture', async () => {
    const io = capture();
    const code = await main(['--config', FIXTURE_CONFIG_FILE, 'check'], io);

    expect(code).toBe(0);
    expect(io.out.join('')).toContain('Encrypted: local, staging, production');
  });

  it('emits notes in list --json', async () => {
    const io = capture();
    const code = await main(
      ['--config', FIXTURE_CONFIG_FILE, 'list', '--json'],
      io,
    );
    const { matrix } = JSON.parse(io.out.join(''));

    expect(code).toBe(0);
    expect(
      matrix.rows.find((row) => row.key === 'SERVICE_KEY_WEB').note,
    ).toMatch(/BFF/);
  });
});

describe('the binary', { timeout: 30_000 }, () => {
  const bin = fileURLToPath(new URL('../bin/sops-env.mjs', import.meta.url));

  it('prints usage and exits 0', () => {
    const result = spawnSync(process.execPath, [bin, '--help'], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: sops-env/);
  });

  it('decrypts the fixture with its key: check --decrypt lists the projections', () => {
    const result = spawnSync(process.execPath, [bin, 'check', '--decrypt'], {
      encoding: 'utf8',
      cwd: FIXTURE_ROOT,
      env: withFixtureKey(),
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /local\/api: 3 keys — DATABASE_URL, LOG_LEVEL, SERVICE_KEY_WEB/,
    );
  });
});
