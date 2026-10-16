export type Note = string | null;

export interface AppConfig {
  scopes: string[];
  dotenv?: string;
  example?: string;
  schema?: { file: string; exportName: string } | null;
  destination?:
    ({ provider: string | Provider } & Record<string, unknown>) | null;
}

export interface Pair {
  name: string;
  left: { scope: string; key: string };
  right: { scope: string; key: string };
  relation: 'equal' | 'differ';
  why: string;
}

export interface Provider {
  name: string;
  label: (ctx: Ctx, target: { app: string; environment?: string }) => string;
  resolve: (
    ctx: Ctx,
    target: { app: string; environment: string; env: NodeJS.ProcessEnv },
  ) => object;
  upsert: (
    credentials: object,
    payload: { env: Record<string, string>; keys: string[]; ctx: Ctx },
    options?: { fetchImpl?: typeof fetch },
  ) => Promise<{ destination: string; keys: string[] }>;
}

export interface SecretsConfig {
  store?: {
    dir?: string;
    file?: string;
    sopsConfig?: string;
    tracked?: string[];
  };
  environments?: Record<string, { nodeEnv: string; sync: boolean }>;
  scopes: Record<string, { keys: Record<string, Note> }>;
  apps: Record<string, AppConfig>;
  schemaRunner?: {
    runner?: 'tsx' | 'node';
    conditions?: string[];
    cwd?: string;
  };
  publicPrefixes?: string[];
  pairs?: Pair[];
  exemptions?: {
    unparsedBySchema?: Record<string, string>;
    platformProvided?: Record<string, string>;
    derived?: Record<string, string>;
  };
  placeholderPattern?: RegExp;
  providers?: Record<string, Record<string, unknown>>;
  contract?: {
    sourceRoots?: string[];
    extraFiles?: string[];
    ignore?: string[];
  };
}

export interface Ctx {
  readonly environments: readonly string[];
  readonly syncable: readonly string[];
  readonly nodeEnv: Readonly<Record<string, string>>;
  readonly scopes: readonly string[];
  readonly registry: Readonly<Record<string, readonly string[]>>;
  readonly notes: Readonly<Record<string, Readonly<Record<string, Note>>>>;
  readonly apps: readonly string[];
  readonly appScopes: Readonly<Record<string, readonly string[]>>;
  readonly deployableApps: readonly string[];
  readonly app: Readonly<
    Record<
      string,
      Required<Omit<AppConfig, 'destination'>> & {
        destination: ({ provider: string } & Record<string, unknown>) | null;
      }
    >
  >;
  readonly exemptions: {
    unparsedBySchema: Record<string, string>;
    platformProvided: Record<string, string>;
    derived: Record<string, string>;
  };
  readonly notDriftWhenUnset: Readonly<Record<string, string>>;
  readonly pairs: readonly Pair[];
  readonly publicPrefixes: readonly string[];
  readonly placeholderPattern: RegExp;
  readonly store: {
    dir: string;
    file: string;
    sopsConfig: string;
    tracked: readonly string[];
  };
  readonly schemaRunner: {
    runner: 'tsx' | 'node';
    conditions: readonly string[];
    cwd: string;
  };
  readonly contract: {
    sourceRoots: readonly string[];
    extraFiles: readonly string[];
    ignore: readonly string[];
  };
  readonly providerConfig: Readonly<Record<string, Record<string, unknown>>>;
  readonly providers: Readonly<Record<string, Provider>>;
  readonly root: string;
  readonly configFile: string;
  relative(absolute: string): string;
}

export function defineConfig(config: SecretsConfig): SecretsConfig;
export function loadConfig(options?: {
  cwd?: string;
  file?: string;
}): Promise<Ctx>;
export function resolveConfig(
  raw: SecretsConfig,
  options: {
    root: string;
    configFile: string;
    providers?: Record<string, Provider>;
  },
): Ctx;
