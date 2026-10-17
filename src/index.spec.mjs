import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as api from './index.mjs';

describe('package.json exports', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

  it('points the types condition at the shipped declaration file', () => {
    expect(pkg.exports['.']).toEqual({
      types: './src/config/types.d.ts',
      default: './src/index.mjs',
    });
    expect(Object.keys(pkg.exports['.'])[0]).toBe('types');
    expect(existsSync(`${root}src/config/types.d.ts`)).toBe(true);
    expect(pkg.exports['./providers']).toEqual({
      default: './src/providers/index.mjs',
    });
  });

  it('ships the declaration file', () => {
    expect(pkg.files).toContain('src');
    expect(pkg.files.filter((entry) => entry.startsWith('!'))).toEqual([
      '!src/**/*.spec.mjs',
    ]);
  });
});

describe('the public API', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BUILTIN_PROVIDERS',
      'assertValidDocument',
      'auditEnvironments',
      'buildMatrix',
      'checkPairs',
      'childEnvironment',
      'collect',
      'countBySeverity',
      'declaresEncryptedKey',
      'decryptSecretsFile',
      'defineConfig',
      'destinationFor',
      'exampleFile',
      'findPlaceholders',
      'formatEnvFile',
      'loadConfig',
      'materializedFindings',
      'pairFindings',
      'parseInventory',
      'placeholderFindings',
      'planSync',
      'productionSourceFiles',
      'projectEnv',
      'providerFor',
      'readDeclarations',
      'readEnvReads',
      'readEnvironment',
      'readExampleKeys',
      'readLastModified',
      'readRecipients',
      'readSchemaDeclarations',
      'readSchemaKeys',
      'render',
      'resolveConfig',
      'schemaFindings',
      'schemaKeysFile',
      'validateProjection',
    ]);
  });
});
