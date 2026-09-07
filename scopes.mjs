/**
 * The scope registry: which variable belongs to which audience.
 *
 * This is an allowlist on purpose, and it is the one security control in the
 * projection path. Without it a `DATABASE_URL` typed under `web:` would be
 * pushed to Vercel by `secrets:sync` and nothing would object; with it, the
 * sync refuses and names the key. Adding a variable therefore means editing
 * this file in the same PR as the `.env.example` entry — the same discipline,
 * one more file.
 *
 * A key may repeat across `api` / `web` / `admin` (they are separate
 * deployments and never merge), but must never appear in both `shared` and an
 * app scope: those two DO merge, and the winner would be positional.
 */

/** @type {readonly ['shared', 'api', 'web', 'admin', 'ingest']} */
export const SCOPES = ['shared', 'api', 'web', 'admin', 'ingest'];

/**
 * Apps that receive a projection: materialize, audit, the env contract. `shared`
 * is not one of them.
 */
export const APPS = ['api', 'web', 'admin', 'ingest'];

/**
 * Apps `secrets:sync` pushes to a platform. `ingest` is materialized locally and
 * in CI but has no Railway service until slice 1b: listing it here would make
 * `planSync` emit a row whose destination cannot be resolved, and `sync.mjs`
 * stops at the first such row — so api, web and admin would stop syncing too
 * (spec §10.2). When the service exists, add `ingest` here AND
 * `RAILWAY_SERVICE_ID_INGEST_<ENV>` to `platform-config.mjs` in the same change.
 */
export const DEPLOYABLE_APPS = ['api', 'web', 'admin'];

/** Scope merge order per app. `shared` first so an app scope is never shadowed. */
export const APP_SCOPES = {
  api: ['shared', 'api'],
  web: ['shared', 'web'],
  admin: ['shared', 'admin'],
  ingest: ['shared', 'ingest'],
};

export const SCOPE_KEYS = {
  shared: [
    // Internal API keys are per consumer (web vs admin), not shared: a leak
    // in one app must not mint the other app's BFF→API perimeter.
  ],
  api: [
    'DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    // The console's own auth origin. Not a duplicate of BETTER_AUTH_URL: Better
    // Auth derives each instance's OAuth redirect_uri from its own base, so one
    // shared value returns every admin Google sign-in to web.
    'BETTER_AUTH_URL_ADMIN',
    'BETTER_AUTH_TRUSTED_ORIGINS',
    // Google OAuth client. `api` only — the client secret must never reach a
    // Vercel front, and the browser talks to Google directly with the id, which
    // Better Auth puts in the authorization URL it returns.
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    // Facebook Login client. `api` only, for exactly the same reason as the
    // Google pair above: the client secret must never reach a Vercel front.
    // Unlike Google's, this pair is optional in production too — it is the kill
    // switch for the provider, so requiring it would break the boot instead of
    // turning the button off (ADR-0026).
    'FACEBOOK_CLIENT_ID',
    'FACEBOOK_CLIENT_SECRET',
    // Passkey capability switch. `api` only — it decides whether the plugin is
    // registered, and the fronts learn the answer from /v1/system-status rather
    // than from an env var of their own.
    'PASSKEY_ENABLED',
    'SECURITY_EVENT_IP_SALT',
    'TRUST_PROXY',
    'SWAGGER_ENABLED',
    'LOG_LEVEL',
    'NODE_ENV',
    'PORT',
    'SENTRY_DSN',
    // Read straight from `process.env` by the import scripts, never by
    // `config/env.ts` — see docs/imports/README.md. Local only.
    'VENDOR_DATA_DIR',
    'TRIPGENCY_INTERNAL_API_KEY_WEB',
    'TRIPGENCY_INTERNAL_API_KEY_ADMIN',
  ],
  web: [
    'TRIPGENCY_API_URL',
    // This app's BFF→API secret. Distinct from admin's; must match
    // `TRIPGENCY_INTERNAL_API_KEY_WEB` on the API.
    'TRIPGENCY_INTERNAL_API_KEY',
    // Country access gate (ADR-0021). `web` only: the API never sees an
    // ungated visitor, since the browser reaches it through the BFF. It moves
    // to `shared` — not duplicated into `api` — if departure-city autocomplete
    // ever needs the same list.
    'ENABLED_COUNTRIES',
    'LOG_LEVEL',
    // NEXT_PUBLIC_* are not parsed by the Zod schema (Next only inlines literal
    // member expressions), but they still have to reach Vercel, so they are
    // part of the projection.
    'NEXT_PUBLIC_SITE_URL',
    'NEXT_PUBLIC_GA_MEASUREMENT_ID',
    'NEXT_PUBLIC_CLARITY_PROJECT_ID',
    'NEXT_PUBLIC_SENTRY_DSN',
    'SENTRY_AUTH_TOKEN',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
  ],
  admin: [
    'TRIPGENCY_API_URL',
    // This app's BFF→API secret. Distinct from web's; must match
    // `TRIPGENCY_INTERNAL_API_KEY_ADMIN` on the API.
    'TRIPGENCY_INTERNAL_API_KEY',
    'LOG_LEVEL',
    'NEXT_PUBLIC_SENTRY_DSN',
    'SENTRY_AUTH_TOKEN',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
  ],
  ingest: [
    'VENDORS_DATABASE_URL',
    'PRODUCT_DATABASE_URL',
    // Read by the worker the way the api reads it: an optional re-root of the dump tree.
    'VENDOR_DATA_DIR',
    'LOG_LEVEL',
    'NODE_ENV',
    'SENTRY_DSN',
  ],
};

/**
 * Registry keys that no app's Zod schema validates, and why.
 *
 * The reason lives here rather than in a comment beside each use, because each
 * of these already has its rationale repeated across two or three files and
 * they drifted. `env-contract.spec.mjs` fails on a registry key that is neither
 * in a schema nor in this map, so a new escape from validation has to be
 * argued for in writing.
 */
export const UNPARSED_BY_ZOD = {
  VENDOR_DATA_DIR:
    'Read straight from process.env by the import scripts, which run with only ' +
    'DATABASE_URL set and must not require the full API environment (Better Auth ' +
    'secrets, the internal key) just to load a CSV.',
  NEXT_PUBLIC_SITE_URL:
    'Next only inlines literal `process.env.NEXT_PUBLIC_X` member expressions, so ' +
    'routing it through a parser would drop the value from the client bundle. ' +
    'Validated at its point of use instead — `lib/site-url.ts` fails production builds.',
  NEXT_PUBLIC_GA_MEASUREMENT_ID:
    'Same inlining constraint. Unset means gtag never loads, so there is nothing ' +
    'to validate beyond presence.',
  NEXT_PUBLIC_CLARITY_PROJECT_ID:
    'Same inlining constraint. Unset means the Clarity tag never loads and ' +
    '`identify` never runs, so there is nothing to validate beyond presence.',
  NEXT_PUBLIC_SENTRY_DSN:
    'Same inlining constraint. Shape is checked at init by `decideDsn` in ' +
    '@tripgency/observability, which warns and degrades to noopReporter.',
  SENTRY_AUTH_TOKEN:
    'Build-time only, read by packages/observability/cjs/next-config.cjs. No app ' +
    'code reads it at runtime; a build without it skips the plugin (ADR-0008).',
  SENTRY_ORG: 'Build-time only, alongside SENTRY_AUTH_TOKEN.',
  SENTRY_PROJECT: 'Build-time only, alongside SENTRY_AUTH_TOKEN.',
};

/**
 * Variables the platform sets, which is why they are absent from the registry
 * and from every `.env.example`: writing them there would suggest an operator
 * is supposed to set them, and syncing them would fight the platform.
 */
export const PLATFORM_PROVIDED = {
  CI: 'Set by GitHub Actions.',
  GITHUB_SHA: 'Set by GitHub Actions to the commit SHA of the workflow.',
  VERCEL: 'Set by Vercel on every build and deployment.',
  VERCEL_ENV: 'Set by Vercel: production | preview | development.',
  VERCEL_URL: 'Set by Vercel to the deployment hostname.',
  VERCEL_GIT_COMMIT_SHA: 'Set by Vercel from the Git integration.',
  RAILWAY_GIT_COMMIT_SHA: 'Set by Railway from the GitHub integration.',
};

/**
 * Variables produced by the build from another variable, never set by hand.
 * Documenting them as inputs would send someone to a dashboard to set a value
 * that the build overwrites.
 */
export const DERIVED = {
  APP_VERSION:
    'Optional test/local override for apps/api/src/config/product-version.ts; ' +
    'deploys derive the product version from the root package.json copied into the image.',
  NEXT_PUBLIC_WEB_BUILD_ID:
    'Assigned by apps/web/next.config.js from VERCEL_GIT_COMMIT_SHA (or "dev"), ' +
    'so /api/sync can spot a stale tab after a deploy.',
};

/** Environments that have a ciphertext file, matching ADR-0018. */
export const ENVIRONMENTS = ['local', 'staging', 'production'];
