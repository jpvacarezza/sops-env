import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaFile } from '../model/env-contract.mjs';
import { projectEnv } from '../store/project.mjs';

/**
 * The environment the child gets: this process's, minus every variable the
 * registry knows about, plus the projection.
 *
 * Stripping first is what makes the answer about the store rather than about the
 * shell it ran in — a DATABASE_URL exported in your terminal would otherwise
 * satisfy a schema the store cannot.
 */
export function childEnvironment(
  ctx,
  projection,
  { environment, base = process.env } = {},
) {
  const known = new Set(Object.values(ctx.registry).flat());
  const inherited = Object.fromEntries(
    Object.entries(base).filter(([key]) => !known.has(key)),
  );
  // `schemaRunner.conditions` maps workspace packages to their sources, so
  // nothing has to be built first. Passed through NODE_OPTIONS because tsx owns
  // its own argv, and appended rather than assigned so a developer's own flags
  // survive.
  const conditions = ctx.schemaRunner.conditions.map(
    (condition) => `--conditions=${condition}`,
  );
  const nodeOptions = [base.NODE_OPTIONS, ...conditions]
    .filter(Boolean)
    .join(' ');

  return {
    ...inherited,
    // The platform sets NODE_ENV, the store does not, so the schema's
    // production-only refinements would be silently disarmed without this. A
    // NODE_ENV in the store still wins.
    NODE_ENV: ctx.nodeEnv[environment] ?? 'development',
    ...projection,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
  };
}

// createRequire resolves from `<root>/node_modules` and then every parent
// directory, as Node does, so a hoisted install above the consumer root is found.
const defaultResolveFrom = (root, specifier) =>
  createRequire(join(root, 'package.json')).resolve(specifier);

/**
 * What to spawn for one app, or why nothing can be. `tsx` is resolved from the
 * CONSUMER root: pnpm does not guarantee a peer is visible from this package's
 * own directory. A missing tool is `unavailable`, never a verdict about the store.
 */
export function runnerCommand(
  ctx,
  { app },
  { resolveFrom = defaultResolveFrom } = {},
) {
  const module = schemaFile(ctx, app);
  if (!module)
    return {
      unavailable: `apps.${app}.schema is not configured in secrets.config.mjs`,
    };
  const { exportName } = ctx.app[app].schema;
  const cwd =
    ctx.schemaRunner.cwd === 'tmp'
      ? tmpdir()
      : resolve(ctx.root, ctx.schemaRunner.cwd);

  if (ctx.schemaRunner.runner === 'node') {
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./validate-projection.mjs', import.meta.url)),
        module,
        exportName,
      ],
      cwd,
    };
  }

  let tsx;
  try {
    tsx = resolveFrom(ctx.root, 'tsx/cli');
  } catch {
    return {
      unavailable: `tsx is not installed in ${ctx.root}; add it as a devDependency, or set schemaRunner.runner to "node" for JS-only schemas`,
    };
  }
  return {
    command: process.execPath,
    args: [
      tsx,
      fileURLToPath(new URL('./validate-projection.ts', import.meta.url)),
      module,
      exportName,
    ],
    cwd,
  };
}

export function defaultRunValidator(ctx, { app, env }, options = {}) {
  const plan = runnerCommand(ctx, { app }, options);
  if (plan.unavailable) return { unavailable: plan.unavailable };
  // Somewhere with no .env files by default: a loader that calls dotenv on paths
  // relative to the CWD would otherwise add variables the store does not have.
  return spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    env,
    cwd: plan.cwd,
    timeout: 60_000,
  });
}

/** Run one app's schema over its projection of one environment. */
export function validateProjection(
  ctx,
  { environment, app, document },
  { runValidator = defaultRunValidator } = {},
) {
  const projection = projectEnv(ctx, document, app);
  const result = runValidator(ctx, {
    app,
    env: childEnvironment(ctx, projection, { environment }),
  });

  if (result.unavailable)
    return { state: 'unavailable', message: result.unavailable };
  if (result.error) {
    return {
      state: 'unavailable',
      message: `Could not run the validator: ${result.error.message}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      state: 'unavailable',
      message:
        'The validator printed no verdict. stderr: ' +
        `${(result.stderr || '').trim().split('\n').slice(-3).join(' ')}`,
    };
  }

  if (parsed.ok) return { state: 'ok' };

  // A validator that could not load its own subject has said nothing about the
  // store. Reporting that as `invalid` would read as "production's config is
  // wrong" when the truth is "this tool is broken", which is a worse error than
  // no error at all.
  return parsed.kind === 'load'
    ? { state: 'unavailable', message: parsed.message }
    : { state: 'invalid', message: parsed.message };
}

export function schemaFindings(environment, app, outcome) {
  if (outcome.state === 'ok') return [];

  if (outcome.state === 'unavailable') {
    return [
      {
        code: 'schema-unchecked',
        severity: 'warn',
        scope: app,
        key: '(schema)',
        environment,
        message: `Could not validate the ${app} projection of ${environment}: ${outcome.message}`,
      },
    ];
  }

  return [
    {
      code: 'schema-invalid',
      severity: 'error',
      scope: app,
      key: '(schema)',
      environment,
      message:
        `The ${app} projection of ${environment} does not satisfy its own ` +
        `schema, so the app would fail at boot:\n${outcome.message}`,
    },
  ];
}
