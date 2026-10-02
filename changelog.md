# Changelog

Release history for `okmodel`. One section per published tag, in reverse order.
This file is the canonical source.

Upcoming work lives under `## Unreleased`. `bun run bump next` moves
`package.json` to `<next release>-next.N` and leaves this section in place.
`bun run bump release` drops the suffix and promotes the section into
`## v<version> — <YYYY-MM-DD>`. Every bullet belongs to an
`### ✨ Added` / `### 💥 Breaking Changes` / `### ♻️ Changed` / `### 🐛 Fixed`
group (also `### ⚠️ Deprecated` · `### 🔥 Removed` · `### 🔒 Security` when
needed). Large groups add `####` area headings (`contracts`, `dialects`,
`adapters`, `runtime`, `tooling`, `docs`) so the list stays scannable.

## Unreleased

### ♻️ Changed

- Source layers use the folder names `contracts`, `dialects`, `adapters`, `runtime`, and `tooling`.
- Lint and format use oxlint and oxfmt. Layer and purity checks read imports from the Oxc AST.
- Declaration emit no longer requires `isolatedDeclarations`, so exported types may be inferred.
- The package description names typed queries, safe migrations, and replica-aware routing. The README says the API has not stabilised yet.
- The migrations spike property test defaults to 100 catalog pairs during `bun run check`. `OKM_MIGRATION_CASES` raises that count. Pairs can now include policies, materialized views, sequences, and extensions the database can install.
- Changelog area headings are the layer names: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.

### ✨ Added

#### tooling

- Stub exports for `okmodel`, `okmodel/pg`, `okmodel/migrate`, and `okmodel/testing`.
- `okm --version` and `okmodel --version` print the package version.
- Repository checks for layer imports, core purity, docs links and decision numbers, publint, arethetypeswrong, and a `dist/` size ceiling.
- `bun run bump next` moves the version to `<next release>-next.N` and leaves the changelog in place. `bun run bump release` drops that suffix and promotes Unreleased.
- Pull requests fail when the package version still matches the base branch, or when Unreleased gained no notes. A release that promotes Unreleased is allowed.
- `bun run db:up` and `bun run db:down` start and stop a Postgres primary with two streaming replicas. `POSTGRES_VERSION` selects 15 through 18.
- Tests can open an isolated PGlite database or a connection to that topology. They skip when Docker or Postgres is down, and fail when `REQUIRE_DOCKER=1`.
- Replay on either replica can be paused and resumed, and tests can read the primary insert LSN and a replica's replay LSN.
- A seeded generator builds schema fixtures of 10, 50, 200, and 500 tables, including a tenant-column variant, as a neutral description and Postgres DDL.
- Type correctness uses `expect-type` in `*.test-d.ts` files compiled by the TypeScript 7 typecheck. A wrong assertion stays in a fixture, and a test shows that `tsc` rejects it.
- `bun run type-cost` reads `tsc --extendedDiagnostics` for a trivial type and writes the counters as JSON. No ceilings yet.
- `@ark/attest` runs on TypeScript 6 in its own CI job. It is not part of `bun run check`.
- `bun run bench` writes timings as JSON. Baselines can be stored beside the script; nothing compares them yet.
- A private catalog spike in `packages/spikes` checks one object contract, dependency order, deterministic hashes, and a scratch-database round trip. Findings are in `packages/spikes/catalog/FINDINGS.md`.
- A private types spike compares inferred and emitted row types on the 10, 50, 200, and 500 table fixtures. Findings are in `packages/spikes/types/FINDINGS.md`.
- A private types spike compares inferred and emitted row types on the 10, 50, 200, and 500 table fixtures. Findings are in `packages/spikes/types/FINDINGS.md`.
- A private safety spike measures tagged operators, runtime identifier checks, and final safety verification over presets, traits, and filters. Findings are in `packages/spikes/safety/FINDINGS.md`.
- A private drivers spike checks one driver contract and a capability registry against postgres.js and PGlite, including cancellation, the `prepared` flag, and atomic `batch`. Findings are in `packages/spikes/drivers/FINDINGS.md`.
- A private migrations spike checks that a catalog diff applied on Postgres matches the target catalog, including rewritten expressions, dependency-aware recreate, lock claims, and a drift hash of the normalised structure. Findings are in `packages/spikes/migrations/FINDINGS.md`.
- A private infra spike checks roles, grants, default privileges, extension inventory on Postgres 15–18, and whether archived rows follow column-strategy migrations. Findings are in `packages/spikes/infra/FINDINGS.md`.
- `bun run spikes:update` rewrites the spike type-cost locks from a fresh `tsc` run.
- The replication test waits up to 30 seconds, matching its replay wait, so other Postgres tests can run beside it.
- A private topology spike routes reads across a Postgres primary and two replicas and checks read-your-writes by WAL position. Findings are in `packages/spikes/topology/FINDINGS.md`.
- A private targets spike resolves a target at execution time, runs migrations across schemas and databases with rollout and resume, and provisions a snapshot that matches a fully migrated target. Findings are in `packages/spikes/targets/FINDINGS.md`.
