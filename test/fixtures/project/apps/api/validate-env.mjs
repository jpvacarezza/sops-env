/**
 * The api's validator command: checks the environment the way the app would at
 * boot. Exit 0 is valid, anything else is invalid. It prints which variable
 * failed and why, never the input.
 */
const env = process.env;
const issues = [];

if (!env.DATABASE_URL) issues.push('DATABASE_URL: required');
if (!env.SERVICE_KEY_WEB || env.SERVICE_KEY_WEB.length < 32)
  issues.push('SERVICE_KEY_WEB: at least 32 characters');
if (
  env.LOG_LEVEL !== undefined &&
  !['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)
)
  issues.push('LOG_LEVEL: one of debug, info, warn, error');
if (
  env.PROXY_HOPS !== undefined &&
  env.PROXY_HOPS !== 'false' &&
  Number.isNaN(Number(env.PROXY_HOPS))
)
  issues.push('PROXY_HOPS: "false" or a number');
if (env.SERVICE_KEY_WEB && env.SERVICE_KEY_WEB === env.DATABASE_URL)
  issues.push('SERVICE_KEY_WEB: must not equal DATABASE_URL');

if (issues.length > 0) {
  console.error(issues.join('\n'));
  process.exit(1);
}
