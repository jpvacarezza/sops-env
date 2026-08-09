import { describe, expect, it } from 'vitest';
import { secretsFilePath } from './paths.mjs';
import { decryptSecretsFile } from './decrypt.mjs';
import { formatEnvFile } from './envfile.mjs';
import { parseRunArgs } from './args.mjs';

describe('secretsFilePath', () => {
  it('maps an environment name onto its ciphertext file', () => {
    expect(secretsFilePath('local', { root: '/repo' })).toBe(
      '/repo/secrets/local.enc.yaml',
    );
    expect(secretsFilePath('production', { root: '/repo' })).toBe(
      '/repo/secrets/production.enc.yaml',
    );
  });

  it('rejects an environment that has no file, listing the ones that do', () => {
    expect(() => secretsFilePath('prod', { root: '/repo' })).toThrow(
      /local, staging, production/,
    );
  });
});

describe('decryptSecretsFile', () => {
  const okRun = () => ({
    status: 0,
    stdout: JSON.stringify({ shared: { TRIPGENCY_INTERNAL_API_KEY: 'x' } }),
    stderr: '',
  });

  it('returns the parsed document', () => {
    expect(
      decryptSecretsFile('secrets/local.enc.yaml', { runSops: okRun }),
    ).toEqual({ shared: { TRIPGENCY_INTERNAL_API_KEY: 'x' } });
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
      parseRunArgs(['local', 'api', '--', 'pnpm', 'nx', 'serve', 'api']),
    ).toEqual({
      environment: 'local',
      app: 'api',
      command: ['pnpm', 'nx', 'serve', 'api'],
    });
  });

  it('requires a -- separator so the command is never guessed', () => {
    expect(() => parseRunArgs(['local', 'api', 'pnpm', 'nx', 'serve'])).toThrow(
      /--/,
    );
  });

  it('rejects an empty command', () => {
    expect(() => parseRunArgs(['local', 'api', '--'])).toThrow(/command/i);
  });

  it('rejects an unknown app before anything is decrypted', () => {
    expect(() => parseRunArgs(['local', 'storybook', '--', 'echo'])).toThrow(
      /storybook/,
    );
  });

  it('rejects an unknown environment', () => {
    expect(() => parseRunArgs(['prod', 'api', '--', 'echo'])).toThrow(/prod/);
  });
});
