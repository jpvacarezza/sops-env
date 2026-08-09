import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACE_ROOT } from './paths.mjs';
import { ENVIRONMENTS } from './scopes.mjs';

/**
 * age public keys are bech32 with an `age1` prefix. Checking the shape here is
 * worth a few lines: a mistyped recipient does not fail at `sops -e` time —
 * it produces a file nobody in the team can decrypt, discovered later.
 */
const AGE_RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;

const USAGE = [
  'usage: pnpm secrets:init --local <age1...> [--local <age1...>] \\',
  '                        [--staging <age1...>] [--production <age1...>] [--force]',
  '',
  'Writes .sops.yaml (public keys only — safe to commit).',
  'Generate an identity with: age-keygen -o ~/.config/sops/age/keys.txt',
].join('\n');

export function renderSopsConfig(recipients) {
  const rules = [];

  for (const environment of ENVIRONMENTS) {
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
    if (!ENVIRONMENTS.includes(environment)) {
      throw new Error(
        `Unknown environment "${environment}". Expected one of: ${ENVIRONMENTS.join(', ')}.`,
      );
    }
  }

  if (rules.length === 0) {
    throw new Error(`No environments given.\n${USAGE}`);
  }

  const body = rules
    .map(
      ({ environment, keys }) =>
        `  # ${environment}\n` +
        `  - path_regex: secrets/${environment}\\.enc\\.yaml$\n` +
        `    age: ${keys.join(',')}`,
    )
    .join('\n');

  return [
    '# Who can decrypt which environment. Public keys only — safe to commit.',
    '# Add a teammate: append their age1... key here, then run',
    '#   sops updatekeys secrets/<environment>.enc.yaml',
    '# Remove one: delete the key, updatekeys, and rotate every value in that file.',
    '# sops takes the FIRST matching rule, so keep these paths exact and unambiguous.',
    'creation_rules:',
    body,
    '',
  ].join('\n');
}

export function parseInitArgs(argv) {
  const recipients = {};
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--force') {
      force = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}".\n${USAGE}`);
    }

    const environment = arg.slice(2);
    if (!ENVIRONMENTS.includes(environment)) {
      throw new Error(`Unknown flag "${arg}".\n${USAGE}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`"${arg}" needs an age public key.\n${USAGE}`);
    }

    recipients[environment] ??= [];
    recipients[environment].push(value);
    index += 1;
  }

  return { recipients, force };
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseInitArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const target = join(WORKSPACE_ROOT, '.sops.yaml');
  if (existsSync(target) && !parsed.force) {
    console.error(
      '.sops.yaml already exists. Edit it by hand to add or remove a recipient ' +
        '(then `sops updatekeys secrets/<environment>.enc.yaml`), or pass --force to overwrite.',
    );
    return 1;
  }

  let content;
  try {
    content = renderSopsConfig(parsed.recipients);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  writeFileSync(target, content);
  console.log(
    `Wrote .sops.yaml for: ${Object.keys(parsed.recipients).join(', ')}.\n` +
      'Next: `pnpm secrets:edit local` to create the first encrypted file.',
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
