# OKModel repository rules

This file is the single source of rules for this repository. `CLAUDE.md` imports it.

## Toolchain

- Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.
- TypeScript 7 is the compiler for typecheck and declaration emit (`tsc`). TypeScript 7.0 has no stable programmatic API, so nothing in `src/`, the typecheck, or the repository checks imports it.
- Type correctness uses `expect-type` (`expectTypeOf`) in `*.test-d.ts` files compiled by that typecheck (D114).
- `bun run type-cost` reads `tsc --extendedDiagnostics` for a trivial type and writes JSON. No ceilings yet.
- `@ark/attest` may run only in its own CI job, on `@typescript/typescript6` (`tsc6`). It is not part of `bun run check`.

## Package layout

- The published package is `okmodel` at the repository root: ESM only, Apache-2.0.
- Other packages live under `packages/*` as Bun workspaces. Their dependencies never go into the root `package.json`.

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

- `bun run check` runs format, lint, typecheck, `type-cost`, `layers-check`, `core-purity`, `docs:check`, the compiler-API scan, build, tests, publint, arethetypeswrong, and the size budget. It does not run `@ark/attest`.
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
- `bun run type-cost` writes TypeScript 7 extended diagnostics for a trivial type as JSON.
- `bun run attest` measures a trivial type with `@ark/attest` on TypeScript 6, outside `bun run check`.
- `bun run bench` writes a JSON timing for the 200-table fixture. Baselines live in `packages/bench/baselines` and are not enforced.

## Docs

Documents in `docs/` are normative.

## Changelog

Before claiming work done, run [`.agents/skills/okm-ship`](.agents/skills/okm-ship/SKILL.md). Append notes to `changelog.md` under `## Unreleased`, then run `bun run bump next`. Never append under a shipped `## v…` section. A gate prompt that releases runs `bun run bump release` instead, which drops the `-next.N` suffix and promotes Unreleased into `## vX.Y.Z — <date>`.

Area headings inside a large group are `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
