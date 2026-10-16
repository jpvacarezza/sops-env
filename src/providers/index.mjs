/**
 * Where an app's projection goes. `vercel` and `railway` ship built in; a
 * consumer adds one inline in the config or as a path imported by `loadConfig`.
 *
 * @typedef {{
 *   name: string,
 *   label: (ctx, { app, environment }) => string,          // 'railway/api'; never a value
 *   resolve: (ctx, { app, environment, env }) => object,   // reads env-var NAMES from ctx, values from env;
 *                                                          // throws `Missing ${NAME}. Set it in the environment …`
 *   upsert: (credentials, { env, keys, ctx }, { fetchImpl }) => Promise<{ destination, keys }>,
 * }} Provider
 */
import * as railway from './railway.mjs';
import * as vercel from './vercel.mjs';

export const BUILTIN_PROVIDERS = Object.freeze({ vercel, railway });

/** The provider module behind an app's destination, or null when it has none. */
export function providerFor(ctx, app) {
  const destination = ctx.app[app]?.destination;
  if (!destination) return null;
  const provider = ctx.providers[destination.provider];
  if (!provider) {
    throw new Error(
      `apps.${app}.destination.provider "${destination.provider}" is not a known provider ` +
        `(known: ${Object.keys(ctx.providers).join(', ')}).`,
    );
  }
  return provider;
}

/** `railway/api`, `vercel/web` — read from the same module the sync applies. */
export function destinationFor(ctx, app) {
  const provider = providerFor(ctx, app);
  return provider ? provider.label(ctx, { app }) : null;
}
