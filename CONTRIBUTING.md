# Contributing

OKModel is built one prompt at a time. Use Bun only (`bun`, `bunx`). Do not use npm, pnpm, yarn, or another package manager.

## Branches

Each prompt in `docs/okmodel-execution-plan.md` gets its own branch (`p01-foundation`, and so on). Open the pull request into `main`. Do not merge it red.

## Checks

Run `bun run check` before opening a pull request. It formats, lints, typechecks, runs the repository checks, builds, tests, and checks the package.

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

TypeScript 7 (`tsc`) is the only compiler. Nothing in this repository may use the TypeScript compiler API. Lint and format go through Biome.
