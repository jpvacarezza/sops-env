import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

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
    vi.stubEnv('SOPS_ENV_CONFIG', '');

    await expect(loadConfig({ cwd: empty })).rejects.toThrow(
      /No secrets\.config\.mjs found walking up from .*Set SOPS_ENV_CONFIG/,
    );
  });

  it('reports a missing explicit file by path', async () => {
    await expect(
      loadConfig({ file: join(scratch(), 'nope.mjs') }),
    ).rejects.toThrow(/nope\.mjs does not exist/);
  });

  it('imports a provider named by relative path and keeps the module unfrozen', async () => {
    const root = scratch();
    writeFileSync(
      join(root, 'secrets.config.mjs'),
      `export default {
  scopes: { api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['api'], destination: { provider: './prov.mjs', service: { staging: 'S' } } } },
};
`,
    );
    writeFileSync(
      join(root, 'prov.mjs'),
      `export const name = 'prov';
export const label = () => 'prov/api';
export const resolve = () => ({});
export const upsert = async () => ({});
`,
    );

    // A real Node process: vitest wraps modules, so only plain Node yields a
    // genuine ES module namespace, which Object.freeze rejects.
    const script = `import { loadConfig } from ${JSON.stringify(
      pathToFileURL(join(import.meta.dirname, 'load.mjs')).href,
    )};
const ctx = await loadConfig({ cwd: ${JSON.stringify(root)} });
console.log(JSON.stringify([
  ctx.providers['./prov.mjs'].label(),
  ctx.app.api.destination.provider,
  Object.isFrozen(ctx.providers),
  Object.isFrozen(ctx.providers['./prov.mjs']),
]));`;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(out)).toEqual(['prov/api', './prov.mjs', true, false]);
  });

  it.each([
    ['resolve', /providers\.prov\.resolve is not a function/],
    ['name', /providers\["\.\/prov\.mjs"\]\.name must be a string/],
  ])(
    'rejects a provider module by path that does not export %s',
    async (missing, message) => {
      const root = scratch();
      writeFileSync(
        join(root, 'secrets.config.mjs'),
        `export default {
  scopes: { api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['api'], destination: { provider: './prov.mjs', service: { staging: 'S' } } } },
};
`,
      );
      const exports = {
        name: `export const name = 'prov';`,
        label: `export const label = () => 'prov/api';`,
        resolve: `export const resolve = () => ({});`,
        upsert: `export const upsert = async () => ({});`,
      };
      delete exports[missing];
      writeFileSync(
        join(root, 'prov.mjs'),
        `${Object.values(exports).join('\n')}\n`,
      );

      await expect(loadConfig({ cwd: root })).rejects.toThrow(message);
    },
  );

  it('rejects an unknown provider name against the builtin registry', async () => {
    const root = scratch();
    writeFileSync(
      join(root, 'secrets.config.mjs'),
      `export default {
  scopes: { api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['api'], destination: { provider: 'heroku' } } },
};
`,
    );

    await expect(loadConfig({ cwd: root })).rejects.toThrow(
      /"heroku" is not a known provider \(known: vercel, railway\)/,
    );
  });

  it('accepts an inline provider object alongside the builtins', async () => {
    const root = scratch();
    writeFileSync(
      join(root, 'secrets.config.mjs'),
      `const fly = {
  name: 'fly',
  label: (_ctx, { app }) => \`fly/\${app}\`,
  resolve: () => ({}),
  upsert: async () => ({}),
};
export default {
  scopes: { api: { keys: { DATABASE_URL: null } }, web: { keys: { A: null } } },
  apps: {
    api: { scopes: ['api'], destination: { provider: fly } },
    web: { scopes: ['web'], destination: { provider: 'vercel', project: 'P' } },
  },
};
`,
    );

    const ctx = await loadConfig({ cwd: root });

    expect(ctx.app.api.destination.provider).toBe('fly');
    expect(ctx.providers.fly.label(ctx, { app: 'api' })).toBe('fly/api');
    expect(ctx.providers.vercel).toBeDefined();
  });

  it('does not freeze the config object the user wrote', async () => {
    const root = scratch();
    writeFileSync(
      join(root, 'secrets.config.mjs'),
      `export const service = { staging: 'S' };
export default {
  scopes: { api: { keys: { DATABASE_URL: null } } },
  apps: { api: { scopes: ['api'], destination: { provider: 'railway', service } } },
};
`,
    );

    await loadConfig({ cwd: root });
    const loaded = await import(
      pathToFileURL(join(root, 'secrets.config.mjs')).href
    );

    expect(Object.isFrozen(loaded.service)).toBe(false);
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
