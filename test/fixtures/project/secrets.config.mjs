/**
 * A small consumer: two apps, three scopes, one pair, one
 * exemption of each kind, one app on Railway and one on Vercel.
 * @type {import('../../../src/config/types.d.ts').SecretsConfig}
 */
export default {
  store: { tracked: ['README.md'] },
  scopes: {
    shared: {
      keys: {
        LOG_LEVEL: 'Read by both apps; the one shared variable.',
      },
    },
    api: {
      keys: {
        DATABASE_URL: null,
        SERVICE_KEY_WEB:
          'Must equal web.SERVICE_KEY; web presents it on every BFF call.',
        PROXY_HOPS: 'Hop count behind the platform proxy. Defaults to false.',
      },
    },
    web: {
      keys: {
        API_URL: null,
        SERVICE_KEY: 'This app’s BFF→API secret.',
        MONITORING_DSN: null,
        NEXT_PUBLIC_SITE_URL: 'Inlined by Next; not parsed by the schema.',
      },
    },
  },
  apps: {
    api: {
      scopes: ['shared', 'api'],
      schema: { file: 'apps/api/src/env.ts', exportName: 'parseApiEnv' },
      destination: {
        provider: 'railway',
        service: {
          staging: 'RAILWAY_SERVICE_ID_API_STAGING',
          production: 'RAILWAY_SERVICE_ID_API_PRODUCTION',
        },
      },
    },
    web: {
      scopes: ['shared', 'web'],
      schema: { file: 'apps/web/src/env.schema.ts', exportName: 'parseWebEnv' },
      destination: { provider: 'vercel', project: 'VERCEL_PROJECT_ID_WEB' },
    },
  },
  pairs: [
    {
      name: 'api ↔ web',
      left: { scope: 'api', key: 'SERVICE_KEY_WEB' },
      right: { scope: 'web', key: 'SERVICE_KEY' },
      relation: 'equal',
      why: 'web presents this key to the API on every BFF call; a mismatch is a blanket 401.',
    },
  ],
  exemptions: {
    unparsedBySchema: {
      NEXT_PUBLIC_SITE_URL:
        'Next only inlines literal process.env.NEXT_PUBLIC_X reads.',
    },
    platformProvided: { CI: 'Set by GitHub Actions.' },
    derived: { BUILD_ID: 'Assigned by the build from the commit SHA.' },
  },
  contract: { sourceRoots: ['apps/*/src'], extraFiles: [] },
};
