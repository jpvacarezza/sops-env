/**
 * The JS twin for runner: 'node' — a consumer whose schema modules are plain JS
 * needs no tsx. argv: `<absolute module path> <export name>`; prints the verdict
 * as JSON on stdout. Never prints a value: the caller reads back only
 * `{ ok, kind, message }`, where `message` is the schema's issue list.
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

function classify(error) {
  const code = error?.code;
  if (code && LOADER_CODES.has(code)) return 'load';
  if (
    error instanceof LoadError ||
    error instanceof SyntaxError ||
    error instanceof ReferenceError
  )
    return 'load';
  return 'invalid';
}

async function validate(modulePath, exportName) {
  const loaded = await import(pathToFileURL(modulePath).href);
  const parse = loaded[exportName];
  if (typeof parse !== 'function') {
    throw new LoadError(
      `${modulePath} exports no "${exportName}" function. apps.<app>.schema.exportName must name a pure parser.`,
    );
  }
  parse(process.env);
}

async function main() {
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
