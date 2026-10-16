// Every test runs with a `fetch` that rejects. A test that needs HTTP injects a
// double at the seam its subject exposes (`fetchImpl` on the providers).
const blockedFetch = (input) =>
  Promise.reject(
    new Error(
      `Blocked a network call from a test: ${describeTarget(input)}\n` +
        'Tests never talk to an external service. Inject `fetchImpl` instead.',
    ),
  );

function describeTarget(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return `${input.method} ${input.url}`;
  return String(input);
}

globalThis.fetch = blockedFetch;
