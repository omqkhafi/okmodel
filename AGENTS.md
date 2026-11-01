# OKModel repository rules

This file is the single source of rules for this repository. `CLAUDE.md` imports it.

## Toolchain

- Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.
- TypeScript 7 is the compiler for typecheck and declaration emit (`tsc`). TypeScript 7.0 has no stable programmatic API and ships no language server, so nothing in `src/`, the typecheck, or the repository checks imports it. `bun run editor-check` spawns TypeScript 6 (`typescript-editor`, dev-only) over stdio for hover, completions, and diagnostics. That package is never imported and never bundled.
- Type correctness uses `expect-type` (`expectTypeOf`) in `*.test-d.ts` files compiled by that typecheck (D114).
- `bun run type-cost` reads `tsc --extendedDiagnostics` and enforces the D133 ceilings on built declarations: inferred 200 tables ≤ 17,831 instantiations and ≤ 6,500 types; inferred 500 tables ≤ 42,400 instantiations; ≤ 84 instantiations per added table; emitted consumer ≤ 700 types; column sample ≤ 720 instantiations and ≤ 1,100 types. The tagged-operator surcharge stays ≤ 800 on the source measurement. Check time is reported and is not a ceiling.
- Core hashing is pure-TypeScript SHA-256 in `contracts`. No `Bun` or Node crypto globals, and no `node:*` imports, in that layer.
- `@ark/attest` may run only in its own CI job, on `@typescript/typescript6` (`tsc6`). It is not part of `bun run check`.

## Package layout

- The published package is `okmodel` at the repository root: ESM only, Apache-2.0, `sideEffects: false`.
- Other packages live under `packages/*` as Bun workspaces. Their dependencies never go into the root `package.json`.
- Normative docs are draft 26 (`docs/okmodel-api-design.md`) and decisions D1–D300. The repository implements that spec through the 0.10.0 release. The M0 spike implementations are on the `m0-spikes` tag. `packages/spikes` keeps the row-type and operator fixtures the type ceilings measure. Findings stay in `docs/m0-findings.md`.

## Errors

- The error class is `OkmError`. Error codes are `OKM1xxx`.

## Layers

Contracts is the lowest layer, tooling the highest. Imports only go down.

- contracts
- dialects
- adapters
- runtime
- tooling

A layer may import layers below it. It must not import a layer above it. Adapters import contracts or other adapter files, not dialects. The order is the rank map in `scripts/layers.ts`. `bun run layers-check` enforces it.

## Scripts

- `bun run check` runs format, lint, typecheck, `editor-check`, `type-cost`, `layers-check`, `core-purity`, `docs:check`, `readme:check`, the compiler-API scan, `bundle-purity`, build, tests, publint, arethetypeswrong, and the size budget. It does not run `@ark/attest`. A pull request runs the fast gate. A push to `main` and the nightly run run the rest. The required status is `gate / check`.
- `bun run verify:fast` once, then push once, then `gh pr merge --auto --squash`, then stop. It checks format, lint, typecheck, layers, purity, docs, and the readme, then runs `bun test --changed` against the merge-base with `origin/main`. Do not poll CI. Do not merge `main` into the branch unless the push is rejected for a real conflict. Do not push an empty commit.
- `bun run build` writes JavaScript with `bun build --target node` and declarations with `tsc` (`emitDeclarationOnly`).
- `bun run typecheck` runs `tsc --noEmit`.
- `bun run lint` uses oxlint with type-aware rules. `bun run format:check` uses oxfmt. `bun run format` rewrites formatting.
- `bun run layers-check` fails when an import goes upward.
- `bun run core-purity` fails on a `node:*` import below tooling and on runtime `dependencies`. The postgres.js adapter may import `node:net` to unref an idle pool socket. The node-postgres adapter may import it to cancel a query.
- `bun run docs:pack` generates public package docs from the site and the error registry into `docs/`. `bun run docs:check` runs that generate step, then checks relative links, `§` references, decision numbers, site→pack mapping, and public-doc hygiene.
- `bun run readme:check` fails when `README.md` contains a relative link or an image that is not an absolute `https://` URL.
- `bun test` covers package exports, the bins, the check fixtures, PGlite, and the schema fixtures. Postgres tests run when the topology is up; they fail instead of skipping when `REQUIRE_DOCKER=1`. PGlite and the in-process wire server stay in that run.
- `bun run bump` moves the version at publish time. `next --publish` sets `<next minor>-next.N` and does not touch the changelog. A pull request does not run it. `release` fills an empty `## Unreleased` from merged pull request titles, drops the suffix, and promotes that section. `patch`, `minor`, `major`, and `--set` still promote the changelog. It does not publish.
- `bun run release-check -- --base <git-rev>` fails when a pull request changes `package.json`'s version (unless that change is `next --publish` or a release) or edits `changelog.md` outside a release. An unchanged version and changelog pass. A release that promotes Unreleased is allowed, including a cut from one bare version to the next when the new `## vX.Y.Z` section has the notes. Before `vX.Y.Z` is tagged, notes added under that heading are allowed and the version stays. CI runs it on pull requests. A pull request whose changed files are all under `.github/` is exempt and prints why; one file outside `.github/` is checked.
- `bun run db:up` and `bun run db:down` start and stop the Postgres topology. `POSTGRES_VERSION` selects 15, 16, 17, or 18 (default 17).
- `bun run test:postgres` runs every test file against that topology. `POSTGRES_EXCLUSIONS` in `scripts/postgres-suite.ts` is the only list of files left out, and each entry has a reason. `bun run test:tarball` packs the tarball and runs the README and the quickstart on the topology.
- `bun run verify` runs that suite in Docker on this machine. One version by default (`POSTGRES_VERSION`, or 17). `--all` runs every supported major. CI stays the authority for a release. A pull request runs Postgres 18 when the diff touches `src/dialects`, `src/runtime`, or `src/tooling/migrate`. A push to `main`, the nightly run, and a release cover 15 through 18 for the suite and the tarball.
- `bun run type-cost` writes TypeScript 7 extended diagnostics as JSON and fails when a D127 ceiling is exceeded.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the `@okmodel/harness` barrel.
- The size check reports `dist/` and does not gate it. The runtime entry (`src/contracts/index.ts`) gate is measured +10% (D144): 6,100 bytes minified and 2,250 gzip. CI fails a runtime-entry cold import above 25 ms. A local sample above 15 ms is a finding. The app and connect gates in `scripts/size.ts` measure the static startup graph with every relative dynamic import stubbed (D248). The full build is printed as a reference and is not gated. Connect-entry cold imports are that reference, printed, not gated; the 15 ms local reference is our own code with the driver stubbed. `okmodel/pg` is printed, not gated. Adapter entries are gated on minified bytes over the runtime entry, and lazy adapter chunks still count (D245).
- `bun run attest` measures a trivial type with `@ark/attest` on TypeScript 6, outside `bun run check`.
- `bun run bench` writes a JSON timing for the 200-table fixture. Baselines live in `packages/bench/baselines` and are not enforced.
- `bun run catalog-bench` times hash, canonical form, and topological order on the 200-table fixture. It prints the sample and does not enforce a ceiling.

## Docs

Edit the handbook under `site/content/docs`. Public package pages under `docs/*.md` (and `docs/errors/OKM####.md`) are generated by `bun run docs:pack` from those site pages and from the error registry; a short hand-kept stop-line list (`guide.md`, `quickstart.md`, `readme-examples.md`) stays in git because no single site page expresses those executable fixtures. Normative internal notes (`docs/okmodel-api-design.md`, `docs/okmodel-decisions.md`, and the other `INTERNAL_DOCS`) stay hand-written in `docs/`. The spec is draft 26. Decisions run D1–D300. GitHub organization is [docs/github.md](docs/github.md) (D206).

Do not read `docs/okmodel-decisions.md`, `docs/okmodel-api-design.md`, `docs/size-audit.md`, `docs/guide.md` in full. Grep by decision number or heading.

## Engineering standards

D129. Built for performance, speed, lightness, and cold start, not only to pass tests.

- Nothing enters the runtime entry (`src/contracts/index.ts`) without need. Tooling stays out of it. No module-level computation. Lazy work. `sideEffects: false`.
- No duplicated logic: one helper, one place.
- Small, obvious public API. Clear names. Precise types. Actionable errors.
- No avoidable allocation or repeated work on hot paths.
- Every report states runtime entry size (minified and gzip), cold import, and any type-cost change.
- Every prompt ends with a self-review against these rules before the report.

## Cursor Cloud

The Cloud Agent image has the Bun version from `.bun-version` on `/usr/local/bin`. `site/` is not a workspace and has its own lockfile; install it with `bun install --cwd site --frozen-lockfile`.

Boot starts Docker, then `bun run db:up` with `OKM_PRIMARY_PORT=55432`, `OKM_REPLICA_A_PORT=55433`, and `OKM_REPLICA_B_PORT=55434`. Leave those set on a rerun so the topology stays on those ports. The primary URL is `postgres://okm:okm@127.0.0.1:55432/okm`. The docs site listens on port 3333. If `docker info` fails, run `sudo service docker start`.

## Hygiene

D115: after the M0 gate, P09A removes spike leftovers, dedupes helpers, stabilises flaky tests, and syncs docs. Every later gate (P17, P30, P44, P55, P66) ends with a lighter hygiene step — dead code, duplicated helpers, flaky tests, doc sync, a dependency audit, and the budgets re-checked — before `bun run bump release`.

## Changelog

Do not edit `changelog.md` or bump the version on a pull request. A release runs `bun run bump release`, which fills an empty `## Unreleased` from merged pull request titles and promotes it into `## vX.Y.Z — <date>`. `bun run bump next --publish` is only for publishing a prerelease, and it does not touch the changelog. Never append under a shipped `## v…` section.

Area headings inside a large generated group are `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
