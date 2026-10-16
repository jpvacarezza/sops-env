import { describe, expect, it } from 'vitest';
import { parseInitArgs, renderSopsConfig } from './init.mjs';

const DEV = 'age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj';
const CI = 'age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg';

describe('renderSopsConfig', () => {
  it('gives each environment its own rule and recipients', () => {
    const yaml = renderSopsConfig({
      local: [DEV],
      staging: [DEV, CI],
      production: [CI],
    });

    expect(yaml).toContain('secrets[/\\\\]local\\.enc\\.yaml$');
    expect(yaml).toContain('secrets[/\\\\]staging\\.enc\\.yaml$');
    expect(yaml).toContain('secrets[/\\\\]production\\.enc\\.yaml$');
    expect(yaml).toContain(`${DEV},${CI}`);
  });

  it('matches the file under either path separator, since sops uses the host spelling', () => {
    // The bug this guards: with a plain `/`, sops on Windows compares against
    // `secrets\local.enc.yaml`, finds no rule, and `sops edit` dies with
    // `no matching creation rules found` while `-d`/`set`/`unset` still work.
    const pattern = /path_regex: (\S+)/.exec(
      renderSopsConfig({ local: [DEV] }),
    );
    const rule = new RegExp(pattern[1]);

    expect(rule.test('secrets/local.enc.yaml')).toBe(true);
    expect(rule.test('secrets\\local.enc.yaml')).toBe(true);
    // Still anchored on both ends — a lookalike must not match.
    expect(rule.test('secrets/local.enc.yaml.bak')).toBe(false);
    expect(rule.test('secrets/production.enc.yaml')).toBe(false);
  });

  it('orders rules from the narrowest environment outward, since sops takes the first match', () => {
    const yaml = renderSopsConfig({
      local: [DEV],
      staging: [CI],
      production: [CI],
    });
    const order = ['local', 'staging', 'production'].map((environment) =>
      yaml.indexOf(`secrets[/\\\\]${environment}`),
    );

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > 0)).toBe(true);
  });

  it('refuses a recipient that is not an age public key', () => {
    expect(() => renderSopsConfig({ local: ['AGE-SECRET-KEY-1ABC'] })).toThrow(
      /public key/i,
    );
    expect(() => renderSopsConfig({ local: ['ssh-ed25519 AAAA'] })).toThrow(
      /public key/i,
    );
  });

  it('refuses an environment with no recipients, which would silently be unencryptable', () => {
    expect(() => renderSopsConfig({ local: [] })).toThrow(/local/);
  });

  it('refuses an unknown environment', () => {
    expect(() => renderSopsConfig({ preview: [DEV] })).toThrow(/preview/);
  });
});

describe('parseInitArgs', () => {
  it('collects repeated flags into per-environment recipient lists', () => {
    expect(
      parseInitArgs(['--local', DEV, '--local', CI, '--production', CI]),
    ).toEqual({
      recipients: { local: [DEV, CI], production: [CI] },
      force: false,
    });
  });

  it('reads --force', () => {
    expect(parseInitArgs(['--local', DEV, '--force']).force).toBe(true);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseInitArgs(['--local'])).toThrow(/--local/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseInitArgs(['--preview', DEV])).toThrow(/--preview/);
  });
});
