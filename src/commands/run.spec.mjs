import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureCtx } from '../../test/helpers/ctx.mjs';

const spawnSync = vi.hoisted(() => vi.fn());
const decryptSecretsFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('../store/decrypt.mjs', () => ({ decryptSecretsFile }));

const { main } = await import('./run.mjs');

const CTX = fixtureCtx();

beforeEach(() => {
  spawnSync.mockReset();
  decryptSecretsFile.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('run', () => {
  it('exits 1 without spawning when the arguments are malformed', () => {
    expect(main(CTX, ['local', 'api'])).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('exits 1 without spawning when decryption fails', () => {
    decryptSecretsFile.mockImplementation(() => {
      throw new Error('cannot decrypt');
    });

    expect(main(CTX, ['local', 'api', '--', 'node'])).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('injects the projection over the ambient environment and returns the child status', () => {
    decryptSecretsFile.mockReturnValue({
      shared: { LOG_LEVEL: 'debug' },
      api: { DATABASE_URL: 'postgres://x' },
      web: { API_URL: 'http://not-for-api' },
    });
    spawnSync.mockReturnValue({ status: 7 });
    vi.stubEnv('LOG_LEVEL', 'stale');

    expect(main(CTX, ['local', 'api', '--', 'node', '-v'])).toBe(7);

    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe('node');
    expect(args).toEqual(['-v']);
    expect(options.stdio).toBe('inherit');
    expect(options.env.LOG_LEVEL).toBe('debug');
    expect(options.env.DATABASE_URL).toBe('postgres://x');
    // Another app's scope never leaks into this app's child.
    expect(options.env.API_URL).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('exits 127 when the command does not exist', () => {
    decryptSecretsFile.mockReturnValue({ shared: {}, api: {}, web: {} });
    spawnSync.mockReturnValue({ error: { code: 'ENOENT' } });

    expect(main(CTX, ['local', 'api', '--', 'nope'])).toBe(127);
  });

  it('exits 1 when the child dies on a signal', () => {
    decryptSecretsFile.mockReturnValue({ shared: {}, api: {}, web: {} });
    spawnSync.mockReturnValue({ status: null });

    expect(main(CTX, ['local', 'api', '--', 'node'])).toBe(1);
  });
});
