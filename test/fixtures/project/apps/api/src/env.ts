import { z } from 'zod';

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    INTERNAL_API_KEY_WEB: z.string().min(32),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: z
      .union([z.literal('false'), z.coerce.number()])
      .default('false')
      .transform((value) => {
        return value === 'false' ? false : value;
      }),
  })
  .refine((data) => data.INTERNAL_API_KEY_WEB !== data.DATABASE_URL, {
    message: 'INTERNAL_API_KEY_WEB must not equal DATABASE_URL',
  });

export function parseApiEnv(source: NodeJS.ProcessEnv) {
  return EnvSchema.parse(source);
}
