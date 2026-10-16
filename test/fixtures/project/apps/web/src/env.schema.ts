import { z } from 'zod';

const EnvSchema = z.object({
  API_URL: z.string().url(),
  INTERNAL_API_KEY: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SENTRY_DSN: z.string().optional(),
});

export function parseWebEnv(source: NodeJS.ProcessEnv) {
  return EnvSchema.parse(source);
}
