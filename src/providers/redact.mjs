/**
 * Make a platform's error text safe to print. An API that rejects a request
 * may quote it back — a 400 body, a GraphQL coercion error naming the input
 * object — and that request carried every value being synced.
 *
 * Every value of four characters or more is replaced, raw and in its JSON-escaped
 * spelling, longest first so a value inside another is not left half-shown. Short
 * values are left alone: replacing `1` or `true` would shred the message and
 * hide nothing. The result is then capped, since a body is not a log.
 */
const MIN_LENGTH = 4;
const LIMIT = 500;

export function redact(text, values, { limit = LIMIT } = {}) {
  let safe = String(text ?? '');
  const spellings = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_LENGTH) continue;
    spellings.add(value);
    spellings.add(JSON.stringify(value).slice(1, -1));
  }
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) {
    if (spelling.length >= MIN_LENGTH)
      safe = safe.replaceAll(spelling, '<redacted>');
  }
  return safe.length > limit ? `${safe.slice(0, limit)}… (truncated)` : safe;
}
