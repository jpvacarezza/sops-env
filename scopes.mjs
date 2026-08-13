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

/** @type {readonly ['shared', 'api', 'web', 'admin']} */
export const SCOPES = ['shared', 'api', 'web', 'admin'];

/** Deployables that receive a projection. `shared` is not one of them. */
export const APPS = ['api', 'web', 'admin'];

/** Scope merge order per app. `shared` first so an app scope is never shadowed. */
export const APP_SCOPES = {
  api: ['shared', 'api'],
  web: ['shared', 'web'],
  admin: ['shared', 'admin'],
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
    'BETTER_AUTH_TRUSTED_ORIGINS',
    'SECURITY_EVENT_IP_SALT',
    'TRUST_PROXY',
    'SWAGGER_ENABLED',
    'LOG_LEVEL',
    'NODE_ENV',
    'PORT',
    'APP_VERSION',
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
};

/** Environments that have a ciphertext file, matching ADR-0018. */
export const ENVIRONMENTS = ['local', 'staging', 'production'];
