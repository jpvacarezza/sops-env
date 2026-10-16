# Verification for behavior-changing PRs

Tests prove the cases someone thought of. A before/after diff proves that
everything else the CLI prints and writes stayed the same. Do it for any PR that
changes what a command outputs, writes or exits with, and say in the PR what ran.

Docs-only and test-only PRs skip this. A change that is meant to alter output
(a new `note` field, a reworded message) still runs it: the diff is the list of
intended deltas, and anything outside the list is a bug.

## Setup

Work from the fixture consumer with its committed age key. The key decrypts
placeholders only.

```sh
cd test/fixtures/project
export SOPS_AGE_KEY_FILE=$PWD/../age-key.txt
SOPS_ENV="node $PWD/../../../bin/sops-env.mjs"
```

`sops` must be on `PATH`. `materialize` writes `apps/*/.env.local` in the
fixture; they are gitignored. Delete them when done.

## Capture on `main`

Check out `main` (a second worktree is simplest), then capture to a directory
outside the repository. Values never appear in these outputs (ADR-0002), so the
files are safe to keep; do not attach decrypted dotenv files to a PR, only their
hashes.

```sh
OUT=/tmp/before   # use /tmp/after on the branch
mkdir -p $OUT
for env in local staging production; do
  $SOPS_ENV list --json $env       > $OUT/list-$env.json;  echo $? >> $OUT/list-$env.json.exit
  $SOPS_ENV audit --no-schema $env > $OUT/audit-$env.txt;  echo $? >> $OUT/audit-$env.txt.exit
done
$SOPS_ENV check --decrypt          > $OUT/check.txt;       echo $? >> $OUT/check.txt.exit
$SOPS_ENV sync staging --dry-run   > $OUT/sync-staging.txt 2>&1; echo $? >> $OUT/sync-staging.txt.exit
$SOPS_ENV materialize local all
sha256sum apps/*/.env.local        > $OUT/materialized.sha256
```

Capture exit codes with the output; an unchanged message with a changed exit code
is a regression. Add any command the PR touches (`list` grid text, `set`
planning, `audit` with the schema pass when `tsx` is installed).

## Change, capture again, diff

Switch to the PR branch, repeat with `OUT=/tmp/after`, then:

```sh
diff -r /tmp/before /tmp/after
```

The result must be empty, byte for byte, or every difference must be one the PR
intends and the description names. Pipe through `jq` only to drop a field the PR
adds on purpose, for example `jq 'del(.rows[].note)'`, and say so.

## State it in the PR

List the commands that ran and the ones that could not, with the reason. For
example: `sync production --dry-run` was not run because no provider
credentials were available; the schema pass was skipped because `tsx` was not
installed. Do not write "verified" about a command that did not run.
