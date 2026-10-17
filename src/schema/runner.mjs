import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { redact } from '../providers/redact.mjs';
import { projectEnv } from '../store/project.mjs';

/**
 * Exit status a validator uses to say "I could not run", as opposed to "the
 * environment is wrong". `EX_CONFIG` from `sysexits.h`. Any other non-zero
 * status is a verdict about the store.
 */
export const COULD_NOT_RUN = 78;

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

  return {
    ...inherited,
    // The platform sets NODE_ENV, the store does not, so production-only
    // refinements would be silently disarmed without this. A NODE_ENV in the
    // store still wins.
    NODE_ENV: ctx.nodeEnv[environment] ?? 'development',
    // The same fact for an app that has no use for NODE_ENV.
    SOPS_ENVIRONMENT: environment,
    ...projection,
  };
}

/**
 * What to spawn for one app, or why nothing can be. The command is an argv
 * array and is never run through a shell, so it is whatever the app uses to
 * validate itself: a Python module, a Go binary, a Node script.
 *
 * `cwd` defaults to the OS temp directory: somewhere with no `.env` files, so a
 * loader that reads dotenv from the working directory cannot add variables the
 * store does not have.
 */
export function runnerCommand(ctx, { app }) {
  const { command, cwd } = ctx.app[app].schema ?? {};
  if (!command) {
    return {
      unavailable: `apps.${app}.schema.command is not configured in secrets.config.mjs`,
    };
  }

  const [file, ...args] = command;
  return {
    command: file,
    args,
    cwd: cwd === 'tmp' ? tmpdir() : resolve(ctx.root, cwd),
  };
}

export function defaultRunValidator(ctx, { app, env }) {
  const plan = runnerCommand(ctx, { app });
  if (plan.unavailable) return { unavailable: plan.unavailable };
  return spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    env,
    cwd: plan.cwd,
    timeout: 60_000,
  });
}

/**
 * Run one app's validator command over its projection of one environment.
 *
 * The contract is the exit status: 0 is valid, `COULD_NOT_RUN` is "this tool is
 * broken, say nothing about the store", anything else is invalid. What the
 * command printed becomes the message, and it is redacted first: a validator
 * that quotes the value it rejected must not put that value in an audit report.
 */
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
  const values = Object.values(projection);
  const printed = () =>
    redact((result.stderr || result.stdout || '').trim(), values);

  if (result.unavailable)
    return { state: 'unavailable', message: result.unavailable };

  if (result.error) {
    // A command that does not exist is a typo in the config. Reporting it as
    // "unchecked" would let that typo switch the gate off behind a warning.
    if (result.error.code === 'ENOENT') {
      return {
        state: 'missing',
        message: `apps.${app}.schema.command ${JSON.stringify(ctx.app[app].schema?.command?.[0])} was not found`,
      };
    }
    return {
      state: 'unavailable',
      message: `Could not run the validator: ${redact(result.error.message, values)}`,
    };
  }

  if (result.status === null) {
    return {
      state: 'unavailable',
      message: `The validator was terminated by ${result.signal ?? 'a signal'}`,
    };
  }

  if (result.status === 0) return { state: 'ok' };

  // A validator that could not load its own subject has said nothing about the
  // store. Reporting that as `invalid` would read as "production's config is
  // wrong" when the truth is "this tool is broken", which is a worse error than
  // no error at all.
  const message = printed() || `exited with status ${result.status}`;
  return result.status === COULD_NOT_RUN
    ? { state: 'unavailable', message }
    : { state: 'invalid', message };
}

export function schemaFindings(environment, app, outcome) {
  if (outcome.state === 'ok') return [];

  if (outcome.state === 'missing') {
    return [
      {
        code: 'schema-missing',
        severity: 'error',
        scope: app,
        key: '(schema)',
        environment,
        message: `The ${app} schema cannot be checked against ${environment}: ${outcome.message}. Fix the command in secrets.config.mjs.`,
      },
    ];
  }

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
