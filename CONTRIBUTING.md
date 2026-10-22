# Contributing

OKModel is built one prompt at a time. Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager. The repository pins one Bun version in `.bun-version` (currently `1.4.3`). CI reads that file. `bun run verify:fast` prints a warning when the local Bun differs and still continues.

## Branches

Each prompt in `docs/okmodel-execution-plan.md` gets its own branch (`p01-foundation`, and so on). Open the pull request into `main`.

The title `type(scope): summary` is the only pull request requirement. The workflow sets `type:` from that title and `area:` from the scope when the scope is a known area, and from the changed paths otherwise. There is no milestone and no `Closes #N` line. See `docs/github.md`.

## Checks

Run `bun run verify:fast` once, push once, then `gh pr merge --auto --squash`, and stop. It checks format, lint, types, layers, purity, docs, and the readme, then runs `bun test --changed` against the merge-base with `origin/main` (Bun 1.4, the flag landed in 1.3.13). A docs-only diff passes with no tests. Do not poll CI. Do not merge `main` into the branch unless the push is rejected for a real conflict. Do not push an empty commit.

Do not edit `changelog.md` or bump `package.json` on a pull request. A release generates the notes from merged titles. A version change that is not a prerelease publish or a release fails the release-flow check, and so does a changelog edit on an ordinary pull request.

When CI fails, read only `bun run ci:fail <pull request number>`. It prints the first failing job, the failing step, the last 60 log lines, and the one local command that reproduces it. Fix that, run `bun run verify:fast`, and push. After two failed rounds, stop and report.

`gate / check` is the required status. It always runs. A pull request runs format, lint, typecheck, the build, tests for the changed files (property tests at `OKM_PROPERTY_SCALE=0.25`), the runtime-entry size ceiling, and the title lint. Postgres 18 runs when the diff touches `src/dialects`, `src/runtime`, or `src/tooling/migrate`. A label does not start it. See [docs/ci-and-test-cycle-plan.md](docs/ci-and-test-cycle-plan.md).

A push to `main` and the nightly run (03:00 UTC) run the rest: type cost, the editor check, attest, the portable runtimes, the temporal matrix, the package checks, Windows, the full test matrix, Postgres 15 through 18, and the tarball. A failure opens or updates one issue titled `CI failed after merge`. A later commit on `main` does not cancel the run already in progress.

`bun run check` is the full local suite. It is not how a pull request finishes.

`bun run db:up` starts the Postgres topology (one primary and two streaming replicas). Set `POSTGRES_VERSION` to 15, 16, 17, or 18. `bun run db:down` stops it and removes its data. Tests that need Postgres skip when Docker is not running, and fail when `REQUIRE_DOCKER=1`. `bun run test:postgres` runs every test file on that topology. A file that cannot run there is named, with the reason, in `scripts/postgres-suite.ts`. `bun run verify` runs that suite here, one version by default and every supported version with `--all`. CI remains the authority for a release.

`bun run format` rewrites formatting. `bun run format:check` only reports it.

Every behavior change ships with a test. Repository checks that can fail have a fixture that proves the failure.

## Commits

The subject is `type(scope): summary`, the same shape as the pull request title (`docs/github.md`). A body is optional. When the change has one, group the lines under `Added:`, `Changed:`, `Fixed:`, or `Removed:`, each followed by `- ` bullets.

End the message with a `Signed-off-by:` trailer that carries your own name and email. `git commit -s` adds it. The sign-off is the DCO certificate of origin: you wrote the change, or you have the right to submit it under Apache-2.0. Do not sign off as someone else, and do not add a tool attribution line.

```
fix(scope): summary

Fixed:
- What was wrong and what changed

Signed-off-by: Your Name <you@example.com>
```

The maintainers' commits in this repository also end with `Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>`. Contributors do not add it.

## Toolchain

TypeScript 7 (`tsc`) typechecks the repository and emits declarations. Nothing in that typecheck uses the TypeScript compiler API. Type assertions live in `*.test-d.ts` files and use `expect-type`. `bun run type-cost` reads `tsc --extendedDiagnostics`, writes JSON, and fails when a D127 ceiling is exceeded. `@ark/attest` runs separately, in `packages/attest`, on `@typescript/typescript6` (`tsc6`), and is not part of `bun run check`. Lint goes through oxlint, including its type-aware rules. Format goes through oxfmt. The published package sets `sideEffects` to false. `bun run bundle-purity` fails when a runtime bundle contains an npm package or when `src/` imports the harness barrel.
