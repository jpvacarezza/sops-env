/**
 * What a consumer gets without saying so. Equal to tripgency on the day of the
 * extraction, except where the spec says otherwise: no pairs, no exemptions,
 * no schema, no destination, no `--conditions`, and `apps/*\/src` alone as the
 * contract's source roots.
 */
export const DEFAULTS = Object.freeze({
  store: {
    dir: 'secrets',
    file: '<environment>.enc.yaml',
    sopsConfig: '.sops.yaml',
    tracked: ['README.md', 'STAGING-PROD-CHECKLIST.md'],
  },
  environments: {
    local: { nodeEnv: 'development', sync: false },
    staging: { nodeEnv: 'staging', sync: true },
    production: { nodeEnv: 'production', sync: true },
  },
  schemaRunner: { runner: 'tsx', conditions: [], cwd: 'tmp' },
  publicPrefixes: ['NEXT_PUBLIC_'],
  pairs: [],
  exemptions: { unparsedBySchema: {}, platformProvided: {}, derived: {} },
  placeholderPattern: /REPLACE_ME|change-me/i,
  providers: {
    vercel: {
      token: 'VERCEL_TOKEN',
      team: 'VERCEL_ORG_ID',
      targets: { staging: ['preview'], production: ['production'] },
    },
    railway: {
      token: 'RAILWAY_TOKEN',
      project: 'RAILWAY_PROJECT_ID',
      environment: {
        staging: 'RAILWAY_ENVIRONMENT_ID_STAGING',
        production: 'RAILWAY_ENVIRONMENT_ID_PRODUCTION',
      },
    },
  },
  contract: {
    sourceRoots: ['apps/*/src'],
    extraFiles: ['apps/*/next.config.js'],
    ignore: ['node_modules', 'out-tsc'],
  },
});

/** Per-app defaults. `scopes` has no default: an app must say what it receives. */
export const APP_DEFAULTS = Object.freeze({
  dotenv: (app) => `apps/${app}/.env.local`,
  example: (app) => `apps/${app}/.env.example`,
  schema: null,
  destination: null,
});
