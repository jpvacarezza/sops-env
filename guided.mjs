/**
 * The guided form behind a bare `pnpm secrets:set`.
 *
 * It exists because the hard part of the CLI was never the syntax, it was
 * knowing which of thirty-four variables lives in which of four scopes and which
 * environments already have it. So every menu is built from the registry and the
 * ciphertext: the key list is `SCOPE_KEYS[scope]` and nothing else — free text
 * would make filing `DATABASE_URL` under `web:` easier than the sops CLI does —
 * and each row carries the presence markers `secrets:list` shows.
 *
 * There is deliberately no "same value for every environment" option. Asking
 * once per environment costs one more prompt and removes the accident
 * `docs/ops/secrets.md` warns about in as many words: never reuse a staging key
 * in production.
 *
 * The three ways it talks to a person are injected, so the whole flow is
 * testable without a terminal — the same reason `decrypt.mjs` takes `runSops`.
 */
import { readEnvironment } from './inventory.mjs';
import { cellMarker, MARKS, readDeclarations, schemaMarker } from './list.mjs';
import { secretsFilePath } from './paths.mjs';
import {
  ask,
  askUntil,
  parseChoice,
  parseConfirm,
  parseMultiChoice,
  readHidden,
  renderMenu,
} from './prompt.mjs';
import {
  APP_SCOPES,
  APPS,
  ENVIRONMENTS,
  SCOPE_KEYS,
  SCOPES,
} from './scopes.mjs';

/** Which environments already hold each key of one scope. */
export function presenceByKey(
  scope,
  inventories,
  { environments = ENVIRONMENTS, registry = SCOPE_KEYS } = {},
) {
  return Object.fromEntries(
    (registry[scope] ?? []).map((key) => [
      key,
      Object.fromEntries(
        environments.map((environment) => [
          environment,
          Boolean(inventories[environment]?.[scope]?.keys?.[key]),
        ]),
      ),
    ]),
  );
}

/** `DATABASE_URL   req   ●○○` — the row that makes an unset cell readable. */
export function keyLabel(
  key,
  presence,
  declaration,
  { environments = ENVIRONMENTS } = {},
) {
  const cells = environments
    .map((environment) =>
      cellMarker({ present: presence[environment], encrypted: true }, true),
    )
    .join('');

  return `${key.padEnd(34)} ${schemaMarker(declaration).padEnd(10)} ${cells}`;
}

export function scopeLabel(
  scope,
  inventories,
  { environments = ENVIRONMENTS, registry = SCOPE_KEYS } = {},
) {
  const declared = (registry[scope] ?? []).length;
  const set = Object.values(
    presenceByKey(scope, inventories, { environments, registry }),
  ).filter((presence) => environments.some((name) => presence[name])).length;
  const apps = Object.entries(APP_SCOPES)
    .filter(([, scopes]) => scopes.includes(scope))
    .map(([app]) => app)
    .join(', ');

  return `${scope.padEnd(8)} ${String(declared).padStart(2)} declared, ${String(set).padStart(2)} set somewhere  →  ${apps}`;
}

/** The declaration that governs a key, whichever app's schema holds it. */
function declarationFor(scope, key, declarations) {
  const candidates = APPS.includes(scope) ? [scope] : APPS;

  for (const app of candidates) {
    if (declarations[app]?.[key]) return declarations[app][key];
  }

  return null;
}

/**
 * Walk the form. Returns the write to perform, or null if the reader backed out.
 *
 * Values come back in a plain object rather than behind a closure, because this
 * one is handed straight to the writer and is never rendered, logged or
 * serialised — the preview prints key names, environments and byte counts only.
 */
export async function runGuided({
  environments = ENVIRONMENTS,
  registry = SCOPE_KEYS,
  output = process.stdout,
  readInventory = (environment) =>
    readEnvironment(secretsFilePath(environment)).inventory,
  loadDeclarations = readDeclarations,
  choose = (question, parse) => askUntil(question, parse, { output }),
  readValue = (prompt) => readHidden(prompt, { output }),
  confirm = async (question) => parseConfirm(await ask(question, { output })),
} = {}) {
  const inventories = Object.fromEntries(
    environments.map((environment) => [
      environment,
      readInventory(environment),
    ]),
  );
  const declarations = loadDeclarations();
  const write = (line = '') => output.write(`${line}\n`);

  write();
  write(
    `  ${MARKS.set} set   ${MARKS.unset} not set   (${environments.join(' ')})`,
  );
  write();
  write('  scope');
  const scopes = SCOPES.filter((scope) => (registry[scope] ?? []).length > 0);
  for (const line of renderMenu(
    scopes.map((scope) =>
      scopeLabel(scope, inventories, { environments, registry }),
    ),
  )) {
    write(line);
  }

  const scope =
    scopes[
      await choose('  > ', (answer) => parseChoice(answer, scopes.length))
    ];

  const keys = registry[scope];
  const presence = presenceByKey(scope, inventories, {
    environments,
    registry,
  });

  write();
  write(`  variable (${scope})`);
  for (const line of renderMenu(
    keys.map((key) =>
      keyLabel(key, presence[key], declarationFor(scope, key, declarations), {
        environments,
      }),
    ),
  )) {
    write(line);
  }

  const key =
    keys[await choose('  > ', (answer) => parseChoice(answer, keys.length))];

  write();
  write('  environments  (a number, several as `1,3`, or `all`)');
  for (const line of renderMenu(
    environments.map(
      (environment) =>
        `${environment.padEnd(12)} ${presence[key][environment] ? `${MARKS.set} already set` : `${MARKS.unset} not set`}`,
    ),
  )) {
    write(line);
  }

  const chosen = (
    await choose('  > ', (answer) =>
      parseMultiChoice(answer, environments.length),
    )
  ).map((index) => environments[index]);

  const values = {};
  write();
  for (const environment of chosen) {
    values[environment] = await readValue(
      `  value for ${environment} (hidden) > `,
    );

    if (values[environment] === '') {
      throw new Error(
        'An empty value and an unset variable mean different things to the ' +
          'schemas. Nothing was written — use `pnpm secrets:unset` if you meant ' +
          'to remove it.',
      );
    }
  }

  write();
  write('  about to write');
  for (const environment of chosen) {
    write(
      `    ${scope}.${key} → secrets/${environment}.enc.yaml` +
        `  (${Buffer.byteLength(values[environment], 'utf8')} bytes)`,
    );
  }
  const untouched = environments.filter((name) => !chosen.includes(name));
  if (untouched.length > 0) write(`    ${untouched.join(', ')} left alone`);

  write();
  if (!(await confirm('  write it? (y/N) > '))) {
    write('  Nothing was written.');
    return null;
  }

  return { environments: chosen, scope, key, values };
}
