import { describe, expect, it } from 'vitest';
import { fixtureCtx, registryCtx } from '../../test/helpers/ctx.mjs';
import { appEnvFilePath, secretsFilePath } from '../store/paths.mjs';
import { decryptSecretsFile } from '../store/decrypt.mjs';
import { formatEnvFile } from '../store/envfile.mjs';
import { parseRunArgs } from './args.mjs';

/**
 * `secretsFilePath` builds a real filesystem path with `join`, so on Windows it
 * separates with `\` while the literals below are POSIX. The function is right —
 * `decryptSecretsFile` opens what it returns — so the assertion is what has to
 * stop being platform-specific.
 *
 * NORMALISED RATHER THAN BUILT WITH `join`. Writing the expectation as
 * `join('/repo', 'secrets', 'local.enc.yaml')` would also pass everywhere, and
 * would pass even if the function joined the wrong pieces: the test would be
 * asserting its own copy of the implementation. Normalising keeps the literal
 * readable and keeps the assertion about the result.
 */
const posix = (value) => value.replaceAll('\\', '/');

const ctx = registryCtx({ shared: [], api: [], web: [], admin: [] });

describe('secretsFilePath', () => {
  it('maps an environment onto its ciphertext file under root', () => {
    expect(posix(secretsFilePath(ctx, 'local'))).toBe(
      '/repo/secrets/local.enc.yaml',
    );
    expect(posix(secretsFilePath(ctx, 'production'))).toBe(
      '/repo/secrets/production.enc.yaml',
    );
  });

  it('honours store.dir and store.file', () => {
    const custom = fixtureCtx({
      store: { dir: 'vault', file: 'env-<environment>.yaml' },
    });
    expect(posix(custom.relative(secretsFilePath(custom, 'local')))).toBe(
      'vault/env-local.yaml',
    );
  });

  it('rejects an environment that has no file, listing the ones that do', () => {
    expect(() => secretsFilePath(ctx, 'prod')).toThrow(
      /local, staging, production/,
    );
  });
});

describe('appEnvFilePath', () => {
  it('reads the dotenv path from the app config', () => {
    expect(posix(appEnvFilePath(ctx, 'api'))).toBe('/repo/apps/api/.env.local');
  });
});

describe('decryptSecretsFile', () => {
  const okRun = () => ({
    status: 0,
    stdout: JSON.stringify({ shared: { INTERNAL_API_KEY: 'x' } }),
    stderr: '',
  });

  it('returns the parsed document', () => {
    expect(
      decryptSecretsFile('secrets/local.enc.yaml', { runSops: okRun }),
    ).toEqual({ shared: { INTERNAL_API_KEY: 'x' } });
  });

  it('explains how to install sops when the binary is missing', () => {
    const runSops = () => ({
      error: Object.assign(new Error('spawn'), { code: 'ENOENT' }),
    });

    expect(() =>
      decryptSecretsFile('secrets/local.enc.yaml', { runSops }),
    ).toThrow(/sops.*not (found|installed)/i);
  });

  it('surfaces sops stderr when decryption fails', () => {
    const runSops = () => ({
      status: 1,
      stdout: '',
      stderr: 'no age identity matched any of the recipients',
    });

    expect(() =>
      decryptSecretsFile('secrets/local.enc.yaml', { runSops }),
    ).toThrow(/no age identity matched/);
  });

  it('fails loudly when sops returns something that is not JSON', () => {
    const runSops = () => ({
      status: 0,
      stdout: 'shared:\n  A: b\n',
      stderr: '',
    });

    expect(() =>
      decryptSecretsFile('secrets/local.enc.yaml', { runSops }),
    ).toThrow(/JSON/i);
  });
});

describe('formatEnvFile', () => {
  it('sorts keys so a regenerated file has a stable diff', () => {
    const text = formatEnvFile({ B_KEY: '2', A_KEY: '1' });
    const keys = text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=')[0]);

    expect(keys).toEqual(['A_KEY', 'B_KEY']);
  });

  it('marks the file as generated', () => {
    expect(formatEnvFile({ A: '1' })).toMatch(/generated/i);
  });

  it('quotes values so spaces, hashes and newlines survive a dotenv read', () => {
    const text = formatEnvFile({
      SPACED: 'two words',
      HASHED: 'a#b',
      MULTI: 'line1\nline2',
    });

    expect(text).toContain('SPACED="two words"');
    expect(text).toContain('HASHED="a#b"');
    expect(text).toContain('MULTI="line1\\nline2"');
  });

  it('escapes quotes and backslashes rather than emitting broken lines', () => {
    expect(formatEnvFile({ Q: 'say "hi"', S: 'a\\b' })).toContain(
      'Q="say \\"hi\\""',
    );
    expect(formatEnvFile({ S: 'a\\b' })).toContain('S="a\\\\b"');
  });
});

describe('parseRunArgs', () => {
  it('splits environment, app and the command after --', () => {
    expect(
      parseRunArgs(ctx, ['local', 'api', '--', 'pnpm', 'nx', 'serve', 'api']),
    ).toEqual({
      environment: 'local',
      app: 'api',
      command: ['pnpm', 'nx', 'serve', 'api'],
    });
  });

  it('requires a -- separator so the command is never guessed', () => {
    expect(() =>
      parseRunArgs(ctx, ['local', 'api', 'pnpm', 'nx', 'serve']),
    ).toThrow(/--/);
  });

  it('rejects an empty command', () => {
    expect(() => parseRunArgs(ctx, ['local', 'api', '--'])).toThrow(/command/i);
  });

  it('rejects an unknown app before anything is decrypted', () => {
    expect(() =>
      parseRunArgs(ctx, ['local', 'storybook', '--', 'echo']),
    ).toThrow(/storybook/);
  });

  it('rejects an unknown environment', () => {
    expect(() => parseRunArgs(ctx, ['prod', 'api', '--', 'echo'])).toThrow(
      /prod/,
    );
  });
});
