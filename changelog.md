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

#### dialects

- `okmodel/pg` builds Postgres column types: keys, numbers, text, boolean, bytea, json, date and time, ranges, network, point and line, tsvector, ltree, enums, domains, arrays, and `custom`. Each one compiles to a catalog column. `citext` and `ltree` record an extension dependency.
- Codecs default to decimal strings for bigint and numeric, and to Temporal for timestamps. `t.bigint({ as: "number" })` and `t.numeric(p, s, { as: "number" })` override a field. `jsonReplacer` writes a bigint as a decimal string.
- `.picklist()` narrows a string column to a literal union and can add a CHECK. An empty list or a repeated value is OKM1060. A value outside the list is OKM1210.
- `enum` and `domain` are exported under those names. An invalid enum or domain definition is OKM1060. A label a codec rejects is OKM1210.
- Date and time codecs read the `Temporal` global. okmodel does not ship a polyfill. A missing global is OKM1210 and the message says to assign one to `globalThis.Temporal`.
- `table()` and `schema()` compile columns, references, indexes, checks, and unique constraints into a catalog. Options that arrive later throw OKM1061 and name that prompt, or say later when the plan has no row for them.
- `Row`, `Insert`, and `Update` read a `Register` schema. `emitRowTypes` writes the same shapes (`Tasks`, `TasksInsert`, `TasksUpdate`). `schema({ types })` records `emitted` or `inferred`.

#### tooling

- Stub exports for `okmodel/migrate` and `okmodel/testing`.
- `okm --version` and `okmodel --version` print the package version.
- Repository checks for layer imports, core purity, docs links and decision numbers, publint, arethetypeswrong, a `dist/` size ceiling, and bundle purity.
- `bun run bump next` moves the version to `<next release>-next.N` and leaves the changelog in place. `bun run bump release` drops that suffix and promotes Unreleased.
- Pull requests fail when the package version still matches the base branch, or when Unreleased gained no notes. A release that promotes Unreleased is allowed.
- `bun run db:up` and `bun run db:down` start and stop a Postgres primary with two streaming replicas. `POSTGRES_VERSION` selects 15 through 18.
- Tests can open an isolated PGlite database or a connection to that topology. They skip when Docker or Postgres is down, and fail when `REQUIRE_DOCKER=1`.
- Replay on either replica can be paused and resumed, and tests can read the primary insert LSN and a replica's replay LSN.
- A seeded generator builds schema fixtures of 10, 50, 200, and 500 tables, including a tenant-column variant, as a neutral description and Postgres DDL.
- Type correctness uses `expect-type` in `*.test-d.ts` files compiled by the TypeScript 7 typecheck. A wrong assertion stays in a fixture, and a test shows that `tsc` rejects it.
- `bun run type-cost` reads `tsc --extendedDiagnostics` and fails when an inferred 200-table type, the per-table rate, the emitted consumer, the tagged-operator surcharge, or the column sample exceeds its D133 ceiling. The gate compiles those fixtures against the built declarations. The source compilation is printed and is not gated, except the tagged-operator surcharge, which stays on the source number.
- `@ark/attest` runs on TypeScript 6 in its own CI job. It is not part of `bun run check`.
- `bun run bench` writes timings as JSON. Baselines can be stored beside the script; nothing compares them yet.
- `bun run catalog-bench` times canonical form, SHA-256, and topological order on the 200-table fixture. It prints the sample and does not enforce a ceiling.
- The replication test waits up to 30 seconds, matching its replay wait, so other Postgres tests can run beside it.
- The runtime entry must stay within 60 KB minified and 20 KB gzip. A cold import on Node is printed and must stay within 15 ms.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the harness barrel.

#### docs

- The M0 gate findings are in `docs/m0-findings.md`, with a Resolved by column for each row.
- Spec section 21 records OKM1026 for a catalog dependency cycle and OKM1027 for a catalog document this version cannot read.
- `docs/editor-check.md` lists a manual check for row-type hover, table-name completion, and a bad reference. It was not run.

### ♻️ Changed

#### contracts

- Catalog serialisation, parsing, hashing, rename, and dependency order are no longer on the runtime entry. They stay in the catalog document module for tooling. Builders, identity, and names stay on `okmodel`.
- SHA-256 round constants and the reserved-word set are built on first use. UTF-8 length and encoding share one helper. An ordering pass computes each identity key once.
- Catalog errors name the accepted value.
- A foreign key whose column type does not match its target is OKM1022. Foreign keys store `onDelete` and `onUpdate`.
- A table or schema option that the types accept but this version does not implement is OKM1061. OKM1060 stays an invalid column definition.
- A catalog dependency cycle is OKM1026. A catalog document this version cannot read is OKM1027. OKM1020 stays the code for an unknown table.
- An invalid column definition is OKM1060. A value a codec rejects is OKM1210. Messages name the accepted values.

#### tooling

- Source layers use the folder names `contracts`, `dialects`, `adapters`, `runtime`, and `tooling`.
- `okmodel` and `okmodel/pg` are built with code splitting. A shared module, including the catalog identity, is emitted once. The bundle-purity check fails when a module is copied into two outputs.
- The published `dist/` is 146975 bytes after code splitting (it was 169519 when each entry inlined the catalog). The ceiling is 184000 bytes, that size plus 25%.
- D133 ratchets type cost to the declaration measurement plus 25 percent, raises the `dist/` ceiling to 241000 bytes, and gates the 10-table app bundle at 48000 bytes minified, 15800 gzip, and 15 ms cold import. The tagged-operator ceiling stays 800 on the source measurement. The cold-import sample is the median of five fresh Node processes.
- `schema()` compiles unique, index, and check options only when a table sets them, so startup does not compile those paths.
- A plain identity key is built without the general JSON encoder, and ASCII identifier lengths skip the UTF-8 walk, so schema startup compiles less.
- Lint and format use oxlint and oxfmt. Layer and purity checks read imports from the Oxc AST.
- Declaration emit no longer requires `isolatedDeclarations`, so exported types may be inferred.
- The published package sets `sideEffects` to false.
- The harness barrel no longer re-exports Postgres or PGlite.
- Postgres tests share one Docker skip rule.

#### docs

- The package description names typed queries, safe migrations, and replica-aware routing. The README says the API has not stabilised yet.
- Changelog area headings are the layer names: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.
- Normative docs match spec draft 22 and decisions D1–D133. The spec registry names OKM1026, OKM1027, OKM1060, OKM1061, and OKM1210.
- Engineering standards (D129) are in `AGENTS.md` and the ship skill. Reports state runtime entry size, cold import, and type-cost change.

### 🔥 Removed

- The M0 spike implementations are deleted. They remain on the `m0-spikes` tag. Findings stay in `docs/`. The row-type and operator fixtures remain so the type ceilings can be measured.
