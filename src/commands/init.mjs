import { existsSync, writeFileSync } from 'node:fs';

import { sopsConfigPath } from '../store/paths.mjs';

/**
 * age public keys are bech32 with an `age1` prefix. Checking the shape here is
 * worth a few lines: a mistyped recipient does not fail at `sops -e` time —
 * it produces a file nobody in the team can decrypt, discovered later.
 */
const AGE_RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;

const usage = (ctx) =>
  [
    `usage: sops-env init --${ctx.environments[0]} <age1...> [--${ctx.environments[0]} <age1...>] \\`,
    `                     ${ctx.environments
      .slice(1)
      .map((name) => `[--${name} <age1...>]`)
      .join(' ')} [--force]`,
    '',
    `Writes ${ctx.store.sopsConfig} (public keys only — safe to commit).`,
    'Generate an identity with: age-keygen -o ~/.config/sops/age/keys.txt',
  ].join('\n');

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function renderSopsConfig(ctx, recipients) {
  const rules = [];

  for (const environment of ctx.environments) {
    const keys = recipients[environment];
    if (keys === undefined) continue;
    if (keys.length === 0) {
      throw new Error(
        `No recipients for "${environment}". An environment with no age key cannot be encrypted.`,
      );
    }
    for (const key of keys) {
      if (!AGE_RECIPIENT_RE.test(key)) {
        throw new Error(
          `"${key}" is not an age public key. Recipients start with \`age1\`; ` +
            'a key starting with `AGE-SECRET-KEY-` is the private half and must never be committed.',
        );
      }
    }
    rules.push({ environment, keys });
  }

  for (const environment of Object.keys(recipients)) {
    if (!ctx.environments.includes(environment)) {
      throw new Error(
        `Unknown environment "${environment}". Expected one of: ${ctx.environments.join(', ')}.`,
      );
    }
  }

  if (rules.length === 0) {
    throw new Error(`No environments given.\n${usage(ctx)}`);
  }

  // `[/\\]` and not `/`: sops matches this regex against the path in the host
  // OS's spelling, so on Windows the candidate is `secrets\local.enc.yaml` and a
  // forward slash never matches. The rule is then simply absent, and the failure
  // surfaces as `no matching creation rules found` on `sops edit` — while
  // `sops -d`, `set` and `unset` keep working, because those read the recipients
  // from the file's own metadata and never consult creation_rules at all.
  // The same holds inside a nested `store.dir` (`config/secrets`).
  const separator = '[/\\\\]';
  const dir = ctx.store.dir.split(/[/\\]/).map(escapeRegex).join(separator);
  const body = rules
    .map(
      ({ environment, keys }) =>
        `  # ${environment}\n` +
        `  - path_regex: ${dir}${separator}${escapeRegex(ctx.store.file).replace('<environment>', environment)}$\n` +
        `    age: ${keys.join(',')}`,
    )
    .join('\n');

  return [
    '# Who can decrypt which environment. Public keys only — safe to commit.',
    '# Add a teammate: append their age1... key here, then run',
    `#   sops updatekeys ${ctx.store.dir}/${ctx.store.file}`,
    '# Remove one: delete the key, updatekeys, and rotate every value in that file.',
    '# sops takes the FIRST matching rule, so keep these paths exact and unambiguous.',
    'creation_rules:',
    body,
    '',
  ].join('\n');
}

export function parseInitArgs(ctx, argv) {
  const recipients = {};
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--force') {
      force = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}".\n${usage(ctx)}`);
    }

    const environment = arg.slice(2);
    if (!ctx.environments.includes(environment)) {
      throw new Error(`Unknown flag "${arg}".\n${usage(ctx)}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`"${arg}" needs an age public key.\n${usage(ctx)}`);
    }

    recipients[environment] ??= [];
    recipients[environment].push(value);
    index += 1;
  }

  return { recipients, force };
}

export function main(ctx, argv) {
  let parsed;
  try {
    parsed = parseInitArgs(ctx, argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const target = sopsConfigPath(ctx);
  if (existsSync(target) && !parsed.force) {
    console.error(
      `${ctx.store.sopsConfig} already exists. Edit it by hand to add or remove a recipient ` +
        `(then \`sops updatekeys ${ctx.store.dir}/${ctx.store.file}\`), or pass --force to overwrite.`,
    );
    return 1;
  }

  let content;
  try {
    content = renderSopsConfig(ctx, parsed.recipients);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  writeFileSync(target, content);
  console.log(
    `Wrote ${ctx.store.sopsConfig} for: ${Object.keys(parsed.recipients).join(', ')}.\n` +
      `Next: \`sops-env edit ${ctx.environments[0]}\` to create the first encrypted file.`,
  );
  return 0;
}
