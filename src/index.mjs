/** Public API. Everything here takes `ctx` from `loadConfig()`/`resolveConfig()` where it reads config. */
export { defineConfig, loadConfig } from './config/load.mjs';
export { resolveConfig } from './config/resolve.mjs';
export { decryptSecretsFile } from './store/decrypt.mjs';
export { formatEnvFile } from './store/envfile.mjs';
export {
  declaresEncryptedKey,
  parseInventory,
  readEnvironment,
  readLastModified,
  readRecipients,
} from './store/inventory.mjs';
export { assertValidDocument, projectEnv } from './store/project.mjs';
export {
  exampleFile,
  productionSourceFiles,
  readEnvReads,
  readExampleKeys,
  readSchemaDeclarations,
  readSchemaKeys,
  schemaFile,
} from './model/env-contract.mjs';
export {
  checkPairs,
  findPlaceholders,
  pairFindings,
  placeholderFindings,
} from './model/invariants.mjs';
export { materializedFindings } from './model/materialized.mjs';
export { buildMatrix, countBySeverity } from './model/matrix.mjs';
export { planSync } from './model/sync-plan.mjs';
export {
  BUILTIN_PROVIDERS,
  destinationFor,
  providerFor,
} from './providers/index.mjs';
export {
  childEnvironment,
  schemaFindings,
  validateProjection,
} from './schema/runner.mjs';
export { auditEnvironments } from './commands/audit.mjs';
export { collect, readDeclarations, render } from './commands/list.mjs';
