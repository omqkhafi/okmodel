# OKModel repository rules

This file is the single source of rules for this repository. `CLAUDE.md` imports it.

## Toolchain

- Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.
- TypeScript 7 is the compiler for typecheck and declaration emit (`tsc`). TypeScript 7.0 has no stable programmatic API, so nothing in `src/`, the typecheck, or the repository checks imports it.
- Type correctness uses `expect-type` (`expectTypeOf`) in `*.test-d.ts` files compiled by that typecheck (D114).
- `bun run type-cost` reads `tsc --extendedDiagnostics` and enforces the D133 ceilings on built declarations: inferred 200 tables ≤ 17,300 instantiations and ≤ 6,500 types; inferred 500 tables ≤ 42,400 instantiations; ≤ 84 instantiations per added table; emitted consumer ≤ 700 types; column sample ≤ 720 instantiations and ≤ 1,100 types. The tagged-operator surcharge stays ≤ 800 on the source measurement. Check time is reported and is not a ceiling.
- Core hashing is pure-TypeScript SHA-256 in `contracts`. No `Bun` or Node crypto globals, and no `node:*` imports, in that layer.
- `@ark/attest` may run only in its own CI job, on `@typescript/typescript6` (`tsc6`). It is not part of `bun run check`.

## Package layout

- The published package is `okmodel` at the repository root: ESM only, Apache-2.0, `sideEffects: false`.
- Other packages live under `packages/*` as Bun workspaces. Their dependencies never go into the root `package.json`.
- Normative docs are draft 22 (`docs/okmodel-api-design.md`) and decisions D1–D133. The M0 spike implementations are on the `m0-spikes` tag. `packages/spikes` keeps the row-type and operator fixtures the type ceilings measure. Findings stay in `docs/m0-findings.md`.

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

- `bun run check` runs format, lint, typecheck, `type-cost`, `layers-check`, `core-purity`, `docs:check`, the compiler-API scan, `bundle-purity`, build, tests, publint, arethetypeswrong, and the size budget. It does not run `@ark/attest`.
- `bun run build` writes JavaScript with `bun build --target node` and declarations with `tsc` (`emitDeclarationOnly`).
- `bun run typecheck` runs `tsc --noEmit`.
- `bun run lint` uses oxlint with type-aware rules. `bun run format:check` uses oxfmt. `bun run format` rewrites formatting.
- `bun run layers-check` fails when an import goes upward.
- `bun run core-purity` fails on a `node:*` import below tooling and on runtime `dependencies`.
- `bun run docs:check` checks relative links, `§` references, and decision numbers.
- `bun test` covers package exports, the bins, the check fixtures, PGlite, and the schema fixtures. Postgres tests run when the topology is up; they fail instead of skipping when `REQUIRE_DOCKER=1`.
- `bun run bump` moves the version. `next` sets `<next minor>-next.N` and does not touch the changelog. `release` drops the suffix and promotes `## Unreleased`. `patch`, `minor`, `major`, and `--set` still promote the changelog. It does not publish.
- `bun run release-check -- --base <git-rev>` fails when `package.json` matches that revision or `changelog.md` has no new lines under `## Unreleased`. A release that promotes Unreleased is allowed. CI runs it on pull requests.
- `bun run db:up` and `bun run db:down` start and stop the Postgres topology. `POSTGRES_VERSION` selects 15, 16, 17, or 18 (default 17).
- `bun run type-cost` writes TypeScript 7 extended diagnostics as JSON and fails when a D127 ceiling is exceeded.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the `@okmodel/harness` barrel.
- The size check keeps the `dist/` ceiling and also requires the runtime entry (`src/contracts/index.ts`) ≤ 60 KB minified, ≤ 20 KB gzip, and a cold Node import ≤ 15 ms. The import time is printed.
- `bun run attest` measures a trivial type with `@ark/attest` on TypeScript 6, outside `bun run check`.
- `bun run bench` writes a JSON timing for the 200-table fixture. Baselines live in `packages/bench/baselines` and are not enforced.
- `bun run catalog-bench` times hash, canonical form, and topological order on the 200-table fixture. It prints the sample and does not enforce a ceiling.

## Docs

Documents in `docs/` are normative. The spec is draft 22. Decisions run D1–D133.

## Engineering standards

D129. Built for performance, speed, lightness, and cold start, not only to pass tests.

- Nothing enters the runtime entry (`src/contracts/index.ts`) without need. Tooling stays out of it. No module-level computation. Lazy work. `sideEffects: false`.
- No duplicated logic: one helper, one place.
- Small, obvious public API. Clear names. Precise types. Actionable errors.
- No avoidable allocation or repeated work on hot paths.
- Every report states runtime entry size (minified and gzip), cold import, and any type-cost change.
- Every prompt ends with a self-review against these rules before the report.

## Hygiene

D115: after the M0 gate, P09A removes spike leftovers, dedupes helpers, stabilises flaky tests, and syncs docs. Every later gate (P17, P30, P44, P55, P66) ends with a lighter hygiene step — dead code, duplicated helpers, flaky tests, doc sync, a dependency audit, and the budgets re-checked — before `bun run bump release`.

## Changelog

Before claiming work done, run [`.agents/skills/okm-ship`](.agents/skills/okm-ship/SKILL.md). Append notes to `changelog.md` under `## Unreleased`, then run `bun run bump next`. Never append under a shipped `## v…` section. A gate prompt that releases runs `bun run bump release` instead, which drops the `-next.N` suffix and promotes Unreleased into `## vX.Y.Z — <date>`.

Area headings inside a large group are `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
