import { decryptSecretsFile } from '../store/decrypt.mjs';
import { secretsFilePath } from '../store/paths.mjs';
import { providerFor } from '../providers/index.mjs';
import { parseSyncArgs, planSync } from '../model/sync-plan.mjs';

/**
 * Decrypt → project → upsert onto Vercel / Railway.
 *
 * Dry-run prints destination + key names only. Live sync never logs values.
 * Deploy is not triggered here (Railway skipDeploys; Vercel env writes do not
 * redeploy) — ADR-0018's git signals remain the promotion path.
 */
export async function main(ctx, argv) {
  let parsed;
  try {
    parsed = parseSyncArgs(ctx, argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const { environment, apps, dryRun } = parsed;

  let doc;
  try {
    doc = decryptSecretsFile(secretsFilePath(ctx, environment));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const plan = planSync(ctx, doc, { environment, apps });

  for (const row of plan) {
    const label = `${row.destination} (${environment}): ${row.keys.length} keys — ${row.keys.join(', ')}`;
    if (dryRun) {
      console.log(`dry-run  ${label}`);
      continue;
    }

    try {
      const provider = providerFor(ctx, row.app);
      const credentials = provider.resolve(ctx, {
        app: row.app,
        environment,
        env: process.env,
      });
      await provider.upsert(credentials, {
        env: row.getEnv(),
        keys: row.keys,
        ctx,
      });
      console.log(`upserted ${label}`);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  return 0;
}
