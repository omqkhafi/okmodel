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

A layer may import layers below it. It must not import a layer above it.

## Docs

Documents in `docs/` are normative.

## Commits

Every commit message ends with exactly these two trailers and nothing else. No tool attribution line.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
