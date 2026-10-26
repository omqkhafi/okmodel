# CI and test cycle plan

How pull requests and `main` run checks. `gate / check` stays the required
status. The heavy jobs run after merge.

## Required status

`gate / check` is the only required status on a pull request. It always runs
(`if: always()`). It depends on the pull request jobs and fails when any
needed job failed, was cancelled, or was skipped while the path rules say it
must pass. The CI workflow has no path or branch filters that would leave the
required check Pending. A skipped Postgres suite is a pass only when the diff
does not touch `src/dialects`, `src/runtime`, or `src/tooling/migrate`.

## Pull request

Every pull request runs format, lint, typecheck, layers, purity, docs, the
readme, the compiler-API scan, bundle purity, the release-flow check, the
build, tests for files changed since the merge base, and the runtime-entry
size ceiling. Property tests in that job use `OKM_PROPERTY_SCALE=0.25`.

Postgres 18 (four shards and the pooler proof) runs when those paths change.
A label does not start it. The tarball does not run on a pull request.

The title `type(scope): summary` is the only pull request rule. The workflow
derives `type:` and `area:` from it and from the paths. A title edit starts
this run again. A body edit does not: `gate / check` repeats the last
conclusion for that commit.

## After merge

A push to `main` and the nightly run (03:00 UTC) run the rest: type cost, the
editor check, attest, portable runtimes, the temporal matrix, package checks
(publint, attw, pack-tracked, pack-contract), Windows, the full test matrix
including `drivers-conformance`, the size report, Postgres 15 through 18, and
the tarball on those majors. Property tests there run at full count.

A failure opens or updates one issue titled `CI failed after merge`. A green
run does not close it. A later commit on `main` does not cancel the run
already in progress.

The release workflow still runs the suite and the tarball on 15 through 18.
`.github/workflows/weekly.yml` is `workflow_dispatch` for that same matrix.

## Concurrency

Pull request runs share one concurrency group per pull request number. A new
push cancels the older run. Each push to `main` is one group per commit. The
nightly run is its own group and does not cancel a push.

## Bun

CI installs the Bun version pinned in `.bun-version`.

## Out of scope here

There is no merge queue on this repository (personal account). There is no
“require branches to be up to date” rule: auto-merge squash is the finish
line. There are no manual required checks.
