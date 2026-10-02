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

### ✨ Added

#### contracts

- `sha256` is a pure-TypeScript SHA-256 in the contracts layer. Fixture hashes use it.
- Catalog objects share one envelope: kind, identity, owner, definition, dependencies, and provenance. Tables, columns, indexes, constraints, and sequences are built here. Views, functions, triggers, extensions, roles, grants, and default privileges use the same envelope.
- Constraint and index names are generated from a stable key. A name past the dialect limit keeps a SHA-256 suffix. Renaming a field does not rename those constraints or indexes.
- A catalog serialises to canonical JSON with a version field. The hash is SHA-256 of that JSON, so the same catalog yields the same bytes on every runtime. Namespace templates stay templates.

#### tooling

- Stub exports for `okmodel`, `okmodel/pg`, `okmodel/migrate`, and `okmodel/testing`.
- `okm --version` and `okmodel --version` print the package version.
- Repository checks for layer imports, core purity, docs links and decision numbers, publint, arethetypeswrong, a `dist/` size ceiling, and bundle purity.
- `bun run bump next` moves the version to `<next release>-next.N` and leaves the changelog in place. `bun run bump release` drops that suffix and promotes Unreleased.
- Pull requests fail when the package version still matches the base branch, or when Unreleased gained no notes. A release that promotes Unreleased is allowed.
- `bun run db:up` and `bun run db:down` start and stop a Postgres primary with two streaming replicas. `POSTGRES_VERSION` selects 15 through 18.
- Tests can open an isolated PGlite database or a connection to that topology. They skip when Docker or Postgres is down, and fail when `REQUIRE_DOCKER=1`.
- Replay on either replica can be paused and resumed, and tests can read the primary insert LSN and a replica's replay LSN.
- A seeded generator builds schema fixtures of 10, 50, 200, and 500 tables, including a tenant-column variant, as a neutral description and Postgres DDL.
- Type correctness uses `expect-type` in `*.test-d.ts` files compiled by the TypeScript 7 typecheck. A wrong assertion stays in a fixture, and a test shows that `tsc` rejects it.
- `bun run type-cost` reads `tsc --extendedDiagnostics` and fails when an inferred 200-table type, the per-table rate, the emitted consumer, or the tagged-operator surcharge exceeds its D127 ceiling.
- `@ark/attest` runs on TypeScript 6 in its own CI job. It is not part of `bun run check`.
- `bun run bench` writes timings as JSON. Baselines can be stored beside the script; nothing compares them yet.
- `bun run catalog-bench` times canonical form, SHA-256, and topological order on the 200-table fixture. It prints the sample and does not enforce a ceiling.
- The replication test waits up to 30 seconds, matching its replay wait, so other Postgres tests can run beside it.
- The runtime entry must stay within 60 KB minified and 20 KB gzip. A cold import on Node is printed and must stay within 15 ms.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the harness barrel.

#### docs

- The M0 gate findings are in `docs/m0-findings.md`, with a Resolved by column for each row.

### ♻️ Changed

#### contracts

- Catalog serialisation, parsing, hashing, rename, and dependency order are no longer on the runtime entry. They stay in the catalog document module for tooling. Builders, identity, and names stay on `okmodel`.
- SHA-256 round constants and the reserved-word set are built on first use. UTF-8 length and encoding share one helper. An ordering pass computes each identity key once.
- Catalog errors name the accepted value. Error codes are unchanged.

#### tooling

- Source layers use the folder names `contracts`, `dialects`, `adapters`, `runtime`, and `tooling`.
- The published `dist/` ceiling is 100000 bytes. The previous 8192 byte ceiling fit the empty package only.
- Lint and format use oxlint and oxfmt. Layer and purity checks read imports from the Oxc AST.
- Declaration emit no longer requires `isolatedDeclarations`, so exported types may be inferred.
- The published package sets `sideEffects` to false.
- The harness barrel no longer re-exports Postgres or PGlite.
- Postgres tests share one Docker skip rule.

#### docs

- The package description names typed queries, safe migrations, and replica-aware routing. The README says the API has not stabilised yet.
- Changelog area headings are the layer names: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.
- Normative docs match spec draft 18 and decisions D1–D127.
- Engineering standards (D129) are in `AGENTS.md` and the ship skill. Reports state runtime entry size, cold import, and type-cost change.

### 🔥 Removed

- The M0 spike implementations are deleted. They remain on the `m0-spikes` tag. Findings stay in `docs/`. The row-type and operator fixtures remain so the type ceilings can be measured.
