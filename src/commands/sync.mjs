import { fileURLToPath } from 'node:url';

import { decryptSecretsFile } from '../store/decrypt.mjs';
import { secretsFilePath } from '../store/paths.mjs';
import {
  resolveRailwayConfig,
  resolveVercelConfig,
} from '../providers/platform-config.mjs';
import { upsertRailwayVariables } from '../providers/railway.mjs';
import { upsertVercelEnv } from '../providers/vercel.mjs';
import { parseSyncArgs, planSync } from '../model/sync-plan.mjs';

/**
 * Decrypt → project → upsert onto Vercel / Railway.
 *
 * Dry-run prints destination + key names only. Live sync never logs values.
 * Deploy is not triggered here (Railway skipDeploys; Vercel env writes do not
 * redeploy) — ADR-0018's git signals remain the promotion path.
 */
export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseSyncArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const { environment, apps, dryRun } = parsed;

  let doc;
  try {
    doc = decryptSecretsFile(secretsFilePath(environment));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const plan = planSync(doc, { environment, apps });

  for (const row of plan) {
    const label = `${row.destination} (${environment}): ${row.keys.length} keys — ${row.keys.join(', ')}`;
    if (dryRun) {
      console.log(`dry-run  ${label}`);
      continue;
    }

    try {
      if (row.app === 'api') {
        const config = resolveRailwayConfig(environment);
        await upsertRailwayVariables({ ...config, env: row.getEnv() });
      } else {
        const config = resolveVercelConfig(row.app, environment);
        await upsertVercelEnv({ ...config, env: row.getEnv() });
      }
      console.log(`upserted ${label}`);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
