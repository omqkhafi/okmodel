# CI and test cycle plan

How pull requests and `main` run checks after the tier split (#381) and the
always-on gate (H1).

## Required status

`gate / check` is the only required status. It always runs (`if: always()`).
It depends on the real CI jobs and fails when any needed job failed, was
cancelled, or was skipped while the tier rules say it must pass. The CI
workflow has no path or branch filters that would leave the required check
Pending. A skipped job must not be how the required check turns green.

## Tiers

**Tier 1** runs on every pull request push: format, lint, typecheck, layers,
purity, docs, unit tests, property tests at `OKM_PROPERTY_SCALE=0.25`, the
size gate, and the release-flow check. With `needs: postgres`, the suite runs
on 15 and 18 and the tarball on 18.

**Tier 2** (full tier) is required when any of these hold:

- the pull request has the `full-ci` label
- the title starts with `chore(release)`
- the diff changes a file under `.github/workflows`
- the event is a push to `main`

Tier 2 adds type cost, the editor check, attest, portable runtimes, the
temporal matrix, package checks, Windows, Postgres 15 and 18, property tests
at full count, and `drivers-conformance`.

A docs-only or site-only diff may still skip the runtime matrix and Postgres;
the gate treats that skip as a pass only when the path filter says those
slices are irrelevant.

**Tier 3** is release and the weekly workflow: every supported Postgres major,
suite and tarball.

## Concurrency

Pull request runs share one concurrency group per pull request number. A new
push cancels the older run. A label or unlabel event does not cancel. Each
push to `main` is one group per commit, so a later commit never cancels an
earlier main run.

## Bun

CI installs Bun 1.4.3 (or newer when the pin moves). Local tooling expects
Bun `>=1.4.0`.

## Out of scope here

There is no merge queue on this repository (personal account). There are no
manual required checks; anything that used to be a manual check becomes a CI
job in a later item when it is automated.
