/**
 * The web app's validator command: checks the environment the way the app would
 * at boot. Exit 0 is valid, anything else is invalid. It prints which variable
 * failed and why, never the input.
 */
const env = process.env;
const issues = [];

if (!env.API_URL || !URL.canParse(env.API_URL))
  issues.push('API_URL: a valid URL');
if (!env.SERVICE_KEY || env.SERVICE_KEY.length < 32)
  issues.push('SERVICE_KEY: at least 32 characters');
if (
  env.LOG_LEVEL !== undefined &&
  !['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)
)
  issues.push('LOG_LEVEL: one of debug, info, warn, error');

if (issues.length > 0) {
  console.error(issues.join('\n'));
  process.exit(1);
}
