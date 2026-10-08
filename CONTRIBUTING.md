# Contributing

OKModel is built one prompt at a time. Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.

## Branches

Each prompt in `docs/okmodel-execution-plan.md` gets its own branch (`p01-foundation`, and so on). Open the pull request into `main`. Do not merge it red.

End the pull request body with `Closes #N`, naming the roadmap issue. Merging closes that issue. Titles, labels, and milestones follow `docs/github.md`.

## Checks

Run `bun run check` before opening a pull request. It formats, lints, typechecks, runs the repository checks, builds, tests, and checks the package.

A pull request fails CI when `package.json`'s version equals the base branch, or when `changelog.md` has no new lines under `## Unreleased`. A release that promotes Unreleased into a dated heading is allowed.

`bun run db:up` starts the Postgres topology (one primary and two streaming replicas). Set `POSTGRES_VERSION` to 15, 16, 17, or 18. `bun run db:down` stops it and removes its data. Tests that need Postgres skip when Docker is not running, and fail when `REQUIRE_DOCKER=1`. `bun run test:postgres` runs every test file on that topology. A file that cannot run there is named, with the reason, in `scripts/postgres-suite.ts`. `bun run verify` runs that suite here, one version by default and every supported version with `--all`. A pull request does not run it. Add the label `needs: postgres` when GitHub should: the suite on 15 and 18, and the tarball on 18. CI remains the authority for a release.

`bun run format` rewrites formatting. `bun run format:check` only reports it.

Every behavior change ships with a test. Repository checks that can fail have a fixture that proves the failure.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```

The sign-off is the DCO certificate of origin.

## Toolchain

TypeScript 7 (`tsc`) typechecks the repository and emits declarations. Nothing in that typecheck uses the TypeScript compiler API. Type assertions live in `*.test-d.ts` files and use `expect-type`. `bun run type-cost` reads `tsc --extendedDiagnostics`, writes JSON, and fails when a D127 ceiling is exceeded. `@ark/attest` runs separately, in `packages/attest`, on `@typescript/typescript6` (`tsc6`), and is not part of `bun run check`. Lint goes through oxlint, including its type-aware rules. Format goes through oxfmt. The published package sets `sideEffects` to false. `bun run bundle-purity` fails when a runtime bundle contains an npm package or when `src/` imports the harness barrel.
