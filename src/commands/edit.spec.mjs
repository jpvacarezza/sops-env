import { existsSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureCtx } from '../../test/helpers/ctx.mjs';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: vi.fn(),
}));

const { main } = await import('./edit.mjs');

const CTX = fixtureCtx();

beforeEach(() => {
  spawnSync.mockReset();
  existsSync.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('edit', () => {
  it('rejects an unknown environment and lists the valid ones', () => {
    expect(main(CTX, ['nowhere'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'usage: sops-env edit <local|staging|production>',
      ),
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('refuses to open sops when there is no sops config', () => {
    existsSync.mockReturnValue(false);

    expect(main(CTX, ['local'])).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('runs sops on the environment file from the project root', () => {
    existsSync.mockReturnValue(true);
    spawnSync.mockReturnValue({ status: 0 });

    expect(main(CTX, ['staging'])).toBe(0);

    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe('sops');
    expect(args[0]).toMatch(/staging\.enc\.yaml$/);
    expect(options).toMatchObject({ stdio: 'inherit', cwd: CTX.root });
  });

  it('explains how to install sops when it is missing', () => {
    existsSync.mockReturnValue(true);
    spawnSync.mockReturnValue({ error: { code: 'ENOENT' } });

    expect(main(CTX, ['local'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('not found on PATH'),
    );
  });

  it('passes the sops exit status through, and 1 when it has none', () => {
    existsSync.mockReturnValue(true);
    spawnSync.mockReturnValueOnce({ status: 200 });
    spawnSync.mockReturnValueOnce({ status: null });

    expect(main(CTX, ['local'])).toBe(200);
    expect(main(CTX, ['local'])).toBe(1);
  });
});
