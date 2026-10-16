/**
 * Runs one app's real Zod schema over the environment it was handed, and prints
 * the verdict as JSON on stdout.
 *
 * A separate process because these are TypeScript modules that import
 * `@tripgency/*`, and because `apps/api/src/config/env.ts` validates at import
 * time — `export const env = loadEnvConfig()`. That side effect is the point
 * here: whatever throws is exactly what would throw when the API boots, refines
 * and all, which is the thing a source scan can never tell you.
 *
 * `.ts` under `tools/` is the exception, not the rule; `tools/testing/no-network.setup.ts`
 * is the other one. Everything else here is `.mjs` run by plain node, because it
 * has to work before anything is built.
 *
 * Never prints a value. The caller passes secrets in this process's environment
 * and reads back only `{ ok, message }`, where `message` is Zod's issue list —
 * which names paths and constraints, never the input.
 */
const APP_MODULES = {
  api: '../../apps/api/src/config/env.js',
  web: '../../apps/web/src/env.schema.js',
  admin: '../../apps/admin/src/env.schema.js',
  ingest: '../../apps/ingest/src/config/env.js',
} as const;

type App = keyof typeof APP_MODULES;

async function validate(app: App): Promise<void> {
  // Dynamic, and inside the try, so api's import-time singleton parse is caught
  // here rather than killing the process with a stack trace.
  const loaded: Record<string, unknown> = await import(APP_MODULES[app]);

  const parse = (loaded.parseApiEnv ??
    loaded.parseWebEnv ??
    loaded.parseAdminEnv ??
    loaded.parseIngestEnv) as
    ((source: NodeJS.ProcessEnv) => unknown) | undefined;

  if (typeof parse !== 'function') {
    throw new Error(
      `${APP_MODULES[app]} exports no pure parser. This tool depends on ` +
        'parseApiEnv / parseWebEnv / parseAdminEnv / parseIngestEnv staying exported.',
    );
  }

  parse(process.env);
}

/**
 * Errors that mean this tool is broken, not that the store is.
 *
 * The distinction matters more than it looks. The specifiers above end in `.js`
 * and only tsx rewrites those to `.ts`, so running this file with plain node
 * fails to resolve every one of them — and without this, that came back as
 * `schema-invalid`, which reads as "production's configuration is wrong". A
 * tooling breakage must never be reported as a defect in the store.
 */
const LOADER_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

function classify(error: unknown): 'load' | 'invalid' {
  const code = (error as { code?: string } | undefined)?.code;

  if (code && LOADER_CODES.has(code)) return 'load';
  // A schema that no longer parses is also this tool's problem to report, not a
  // statement about any environment's values.
  if (error instanceof SyntaxError || error instanceof ReferenceError) {
    return 'load';
  }

  return 'invalid';
}

async function main(): Promise<void> {
  const app = process.argv[2] as App;

  if (!(app in APP_MODULES)) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        kind: 'load',
        message: `Unknown app "${app}". Expected one of: ${Object.keys(APP_MODULES).join(', ')}.`,
      }),
    );
    return;
  }

  try {
    await validate(app);
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    const kind = classify(error);
    const message = error instanceof Error ? error.message : String(error);

    process.stdout.write(
      JSON.stringify({
        ok: false,
        kind,
        message:
          kind === 'load'
            ? `${message} (this file has to run through tsx: the app modules are TypeScript and the specifiers end in .js)`
            : message,
      }),
    );
  }
}

void main();
