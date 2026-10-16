# ADR-0003: Distribution by first-party git tag, not npm

- Status: accepted
- Date: 2026-10-16

## Context

Consumers, Vercel and Railway builds included, run `pnpm install` without
credentials, so a private `github:` dependency returns 404. Publishing to npm
would add a registry account to the trust surface and a publish step to every
release, for a tool whose consumers are all owned by one person.

## Decision

- The repository is public, MIT, and consumed as
  `"sops-env": "github:jpvacarezza/sops-env#vX.Y.Z"`. It is not published to
  npm.
- **The pin is the commit SHA pnpm writes to the consumer's `pnpm-lock.yaml`,
  not the tag.** A tag can be moved; `--frozen-lockfile` holds the SHA. A bump
  is reviewed against the tag's compare list and the CHANGELOG entry, and the
  reviewer checks that `git ls-remote <repo> 'refs/tags/vX.Y.Z^{}'` equals the
  lockfile SHA.
- **No lifecycle scripts.** `package.json` has no `prepare`, `postinstall` or
  `build`. pnpm runs `prepare` on git dependencies, which would need the
  devDependencies at install time; its absence keeps the install a tarball
  unpack. Source ships as is (`files` excludes specs).
- Tags are `vX.Y.Z`; a tag workflow publishes the CHANGELOG section as the
  GitHub release notes.

## Consequences

- A registry publish-age gate (`minimumReleaseAge`, `trustPolicy`) evaluates
  registry metadata that a git dependency does not have. The defense that
  applies here is the lockfile SHA plus the first-party rule: a hijacked GitHub
  account would own this repository directly.
- Consumers must not install this dependency with `--trust-lockfile` or an
  unfrozen lockfile.
- Making the repository private, or accepting a third-party git dependency,
  needs a new ADR.
