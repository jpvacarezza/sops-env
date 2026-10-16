import { describe, expect, it } from 'vitest';

import * as api from './index.mjs';

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
      'schemaFile',
      'schemaFindings',
      'validateProjection',
    ]);
  });
});
