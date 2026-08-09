import { spawnSync } from 'node:child_process';

const INSTALL_HINT =
  'Install it with `brew install sops` (macOS) or from ' +
  'https://github.com/getsops/sops/releases, then make sure your age identity is at ' +
  '$SOPS_AGE_KEY_FILE (default ~/.config/sops/age/keys.txt).';

/**
 * Decrypt one SOPS document into a plain object.
 *
 * JSON rather than YAML output: it needs no YAML parser here, and it removes
 * the class of bug where an unquoted `true` or `6003` arrives as a boolean or
 * a number and then fails much later, inside a platform API call.
 *
 * Nothing in this module logs the decrypted document. `sops` stderr is safe to
 * surface — it reports key and recipient problems, never values.
 */
export function decryptSecretsFile(file, { runSops = defaultRunSops } = {}) {
  const result = runSops(file);

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`\`sops\` was not found on PATH. ${INSTALL_HINT}`);
    }
    throw new Error(`Could not run \`sops\`: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `\`sops -d ${file}\` failed with exit code ${result.status}.\n` +
        `${(result.stderr || '').trim()}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `\`sops -d ${file}\` did not return JSON. Check that the file is a SOPS document ` +
        'and that sops is recent enough to support `--output-type json`.',
    );
  }
}

function defaultRunSops(file) {
  return spawnSync('sops', ['-d', '--output-type', 'json', file], {
    encoding: 'utf8',
  });
}
