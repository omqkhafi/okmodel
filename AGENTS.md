# OKModel repository rules

This file is the single source of rules for this repository. `CLAUDE.md` imports it.

## Toolchain

- Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.
- TypeScript 7 is the only compiler. It is the native compiler, invoked as `tsc`.
- Tools must not use the TypeScript compiler API.

## Package layout

- The published package is `okmodel` at the repository root: ESM only, Apache-2.0.
- Other packages live under `packages/*` as Bun workspaces. Their dependencies never go into the root `package.json`.

## Errors

- The error class is `OkmError`. Error codes are `OKM1xxx`.

## Layers

Imports go only downward:

- L0 contracts
- L1 dialects
- L2 adapters
- L3 runtime
- L4 tooling

A layer may import layers below it. It must not import a layer above it. L2 adapters import L0 contracts or other L2 files, not L1 dialects. `bun run layers-check` enforces this.

## Scripts

- `bun run check` runs format, lint, typecheck, `layers-check`, `core-purity`, `docs:check`, the compiler-API scan, build, tests, publint, arethetypeswrong, and the size budget.
- `bun run build` writes JavaScript with `bun build --target node` and declarations with `tsc` (`emitDeclarationOnly`).
- `bun run typecheck` runs `tsc --noEmit`.
- `bun run lint` and `bun run format:check` use Biome. `bun run format` rewrites formatting.
- `bun run layers-check` fails when an import goes upward.
- `bun run core-purity` fails on a `node:*` import in L0–L3 and on runtime `dependencies`.
- `bun run docs:check` checks relative links, `§` references, and decision numbers.
- `bun test` covers package exports, the bins, and the check fixtures.
- `bun run bump` promotes `changelog.md` and the package version. It does not publish.

## Docs

Documents in `docs/` are normative.

## Changelog

Before claiming work done, run [`.agents/skills/okm-ship`](.agents/skills/okm-ship/SKILL.md). Append notes to `changelog.md` under `## Unreleased`. Never append under a shipped `## v…` section. `bun run bump` promotes Unreleased into the next `## vX.Y.Z — <date>`.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
