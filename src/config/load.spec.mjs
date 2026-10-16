import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defineConfig, findConfigFile, loadConfig } from './load.mjs';

const CONFIG = `export default {
  scopes: { shared: { keys: {} }, api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['shared', 'api'] } },
};
`;

const scratch = () => mkdtempSync(join(tmpdir(), 'sops-env-load-'));

describe('findConfigFile', () => {
  it('walks up from cwd to the nearest secrets.config.mjs', () => {
    const root = scratch();
    writeFileSync(join(root, 'secrets.config.mjs'), CONFIG);
    const deep = join(root, 'apps', 'api', 'src');
    mkdirSync(deep, { recursive: true });

    expect(findConfigFile(deep)).toBe(join(root, 'secrets.config.mjs'));
  });

  it('returns null when nothing is found', () => {
    expect(findConfigFile(scratch())).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads and resolves, rooting ctx at the file directory', async () => {
    const root = scratch();
    writeFileSync(join(root, 'secrets.config.mjs'), CONFIG);

    const ctx = await loadConfig({ cwd: join(root) });

    expect(ctx.root).toBe(root);
    expect(ctx.configFile).toBe(join(root, 'secrets.config.mjs'));
    expect(ctx.registry.api).toEqual(['DATABASE_URL']);
  });

  it('takes an explicit file over the walk', async () => {
    const root = scratch();
    writeFileSync(join(root, 'custom.config.mjs'), CONFIG);

    const ctx = await loadConfig({
      cwd: tmpdir(),
      file: join(root, 'custom.config.mjs'),
    });

    expect(ctx.root).toBe(root);
  });

  it('names the file and the env var when nothing is found', async () => {
    const empty = scratch();

    await expect(loadConfig({ cwd: empty, file: undefined })).rejects.toThrow(
      /No secrets\.config\.mjs found walking up from .*Set SOPS_ENV_CONFIG/,
    );
  });

  it('reports a missing explicit file by path', async () => {
    await expect(
      loadConfig({ file: join(scratch(), 'nope.mjs') }),
    ).rejects.toThrow(/nope\.mjs does not exist/);
  });

  it('reports a file with no default export', async () => {
    const root = scratch();
    writeFileSync(join(root, 'secrets.config.mjs'), 'export const x = 1;\n');

    await expect(loadConfig({ cwd: root })).rejects.toThrow(
      /has no default export/,
    );
  });
});

describe('defineConfig', () => {
  it('returns its argument unchanged', () => {
    const config = { scopes: {}, apps: {} };
    expect(defineConfig(config)).toBe(config);
  });
});
