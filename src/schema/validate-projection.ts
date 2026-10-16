/**
 * Runs one app's real schema over the environment it was handed and prints the
 * verdict as JSON on stdout. argv: `<absolute module path> <export name>`.
 *
 * A separate process because the module may validate at import time, and
 * because whatever throws here is exactly what would throw at boot. Never
 * prints a value: the caller reads back only `{ ok, kind, message }`, where
 * `message` is the schema's issue list — paths and constraints, never input.
 */
import { pathToFileURL } from 'node:url';

const LOADER_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

class LoadError extends Error {}

function classify(error: unknown): 'load' | 'invalid' {
  const code = (error as { code?: string } | undefined)?.code;
  if (code && LOADER_CODES.has(code)) return 'load';
  if (
    error instanceof LoadError ||
    error instanceof SyntaxError ||
    error instanceof ReferenceError
  )
    return 'load';
  return 'invalid';
}

async function validate(modulePath: string, exportName: string): Promise<void> {
  const loaded: Record<string, unknown> = await import(
    pathToFileURL(modulePath).href
  );
  const parse = loaded[exportName];
  if (typeof parse !== 'function') {
    throw new LoadError(
      `${modulePath} exports no "${exportName}" function. apps.<app>.schema.exportName must name a pure parser.`,
    );
  }
  (parse as (source: NodeJS.ProcessEnv) => unknown)(process.env);
}

async function main(): Promise<void> {
  const [modulePath, exportName] = process.argv.slice(2);
  if (!modulePath || !exportName) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        kind: 'load',
        message: 'usage: validate-projection <module> <exportName>',
      }),
    );
    return;
  }
  try {
    await validate(modulePath, exportName);
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    const kind = classify(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, kind, message }));
  }
}

void main();
