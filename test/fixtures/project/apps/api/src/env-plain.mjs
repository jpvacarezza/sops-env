/** A JS-only schema for the `runner: 'node'` path: no zod, no tsx. */
export function parse(source) {
  if (!source.DATABASE_URL) throw new Error('DATABASE_URL: required');
  return { DATABASE_URL: source.DATABASE_URL };
}
