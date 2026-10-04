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

#### dialects

- A column can be a primary key with `.primaryKey()`, and a table can declare a composite primary key with `primaryKey`. A natural key and a caller-supplied id insert, and `find` looks them up.
- `t.id()` still defaults to database `uuidv7()`. `t.id({ default: "uuidv4" })` uses `gen_random_uuid()`. `t.id({ default: "none" })` has no default and is required on insert. A column choice wins over `schema({ defaults: { id } })`.
- `schema({ defaults: { id } })` sets the generator for every bare `t.id()`. `"uuidv4"` and `"uuidv7"` stay database defaults. A function is filled in the application.
- An OKID id is `text` with collation `C`. Collation is part of the catalog: create, diff, introspect, and plan.
- `.hidden()` stays out of default selects and includes, and is returned only when a root `select` names it. `.sensitive()` redacts the value in logs, errors, and `inspect()`.
- `filters()` is synchronous and throws OKM1123 when `allow`, `sort`, or `relations` names a hidden field. `parse()` loads the parser on first use.
- `schema({ traits })` applies those traits to every table. A table opts out with `omitDefaults` and a reason. A field the table already declares is OKM1012.
- `contains`, `containedBy`, `overlaps`, `hasKey`, `hasAnyKey`, `path`, and `matches` filter json, array, range, and tsvector columns. Text `contains` stays a substring. The value, key, or path is a parameter, and a regconfig name is checked before it is bound.
- `json.set`, `arr.append`, and `arr.remove` are namespace exports used inside `update`. Importing one does not pull the others.

#### adapters

- `okmodel/pg/pg` connects with node-postgres, and `okmodel/pg/bun` connects with Bun.sql. Both are optional peers. The default stays postgres.js. Bun.sql loads only on Bun.
- node-postgres cancels an in-flight statement and returns notices. Bun.sql does not abort an in-flight statement and does not surface RAISE NOTICE. Neither describes a statement without running it. A plain pool of either exits after the last query.

#### runtime

- `connect()` refuses a Postgres server below 15 with OKM1803. `schema({ requires })` that names an older major keeps the OKM1802 check instead.
- `okmodel/ids` exports `uuidv4`, `uuidv7`, and `okid`. Pass one to `.default()` or `defaults.id`. A literal passed to `.default()` stays a database default. `.defaultSql()` stays a database expression. The generated value is not in the catalog, so changing a generator does not produce a migration. Insert fills each omitted value once, including each row of a batch, and the returned row carries it.
- `connect({ generators })` replaces a built-in generator by name.
- An operator that does not fit its column fails with OKM1124. The message names the column type and the operators that column accepts. Text search on a text column says it needs a tsvector column.
- A table records the file and line where it was defined. `inspect()` shows that location on the catalog rules, a schema error includes it, and `okm` prints it. The catalog hash does not.
- `okmodel/safety` is the registry later checks plug into. `registerRule` adds a rule, `verify` throws OKM1190 with every violation in stable order, and `safety.property` fails when rule order changes the verdict.
- `okmodel/traits` exports `timestamps()` and `trait()`. `timestamps()` adds `createdAt` and `updatedAt`. Insert leaves both to `now()`. Update sets `updatedAt` to `now()` and leaves `createdAt`. Input cannot set either, including `{ allow }`. An application that imports no trait does not load that code.
- `registerTimestamps()` records the timestamps check. A timestamp set by input is OKM1190. `{ allow }` does not clear it.
- `registerFieldExposure()` records the hidden, sensitive, and guarded checks. A hidden field shown, a sensitive value revealed, or a guarded field set without `{ allow }` is OKM1190.
- Unknown keys are dropped on insert and update. A guarded field is OKM1190 unless `{ allow }` names it. `allow` does not unlock a primary key on update.

#### tooling

- `engines.node` is `>=22`. The checks that can run do so on Node, Bun, and Deno, and the runtime entry is imported as an edge bundle. A runtime that cannot run a check prints the reason.

#### docs

- The README lists the key options. The quickstart stays on `t.identity()`. Schema says how ids are generated and how to change the default.
- The roadmap is a public board. Each release is a milestone, and a pull request ends with `Closes #N`.
- The README shows a jsonb `contains` filter and an array update with `arr.append`.
- The size page records the no-trait startup graph at 83,043 minified bytes and 27,666 gzip. The gates stay. An application that uses `timestamps()` measures 85,744 / 28,503, and that figure is not a gate.

### 💥 Breaking Changes

- `import { json }` is the write namespace (`json.set`). A json column is `t.json()`.

### ♻️ Changed

- A push to main runs check and attest. The Postgres suite and the tarball job stay on pull requests, the release workflow, and the weekly run.
- A declared server below 18 that uses `uuidv7()` fails with OKM1812, and the message names `defaults.id`.
- `okmodel/pg/pg` and `okmodel/pg/bun` connect entries are gated at the measured size plus 3 percent (D156).
- `t.id()` and `t.identity()` stay omitted from insert and update. A plain primary key is writable on insert and omitted from update. Changing it is OKM1190.
- A postgres.js pool opened with TLS still lingers about 30 s after the last query on Node and Bun. A plain pool exits on its own. `close()` or `await using` releases it.
- A release checks the tag, packs one tarball, tests that file on Postgres, and publishes that same file. The GitHub Release closes the milestone.
- The npm description is one sentence.
- App startup is gated at 85,100 minified and 28,000 gzip (D158). postgres.js connect is 40,800 / 14,100, `pg` is 41,000 / 14,250, and Bun.sql is 39,800 / 13,800. PGlite stays 38,146 / 13,505.
- Synchronous `filters()` takes the app startup graph to 84,907 / 28,017, past the gzip gate. The gates move to measured plus 3 percent (D160): app startup 87,454 / 28,857, postgres.js 41,519 / 14,352, PGlite 38,620 / 13,613, `pg` 41,677 / 14,543, and Bun.sql 40,545 / 14,096. The 91,000 / 30,000 cap stays.
- `filters()` returns the parser directly. The promise is on `parse()`, which is what a request handler awaits.
- A signal or timeout, a watched query, checkout, listen, stream, the server-version query, and the fix text for write and include errors load on first use. Error codes, messages, SQL, and catalog output stay the same. The no-trait startup graph goes from 85,568 / 28,329 to 83,043 / 27,666. The gates stay.

## v0.1.1 — 2026-10-03

### ✨ Added

- The published README is the newcomer page: install, a default-exported schema, `okm push`, then `okm generate` and `okm migrate apply`, a shared client, insert, find with an include, and `safe` / `OkmError`.
- `bun run check` fails when `README.md` contains a relative link or an image.
- `bun run verify` runs the Postgres suite against Docker on this machine. One version by default (`POSTGRES_VERSION`, or 17). `--all` runs every supported major. CI stays the authority for a release.
- A connected client implements `Symbol.asyncDispose` when the runtime has it, so `await using` closes the pool. `close()` can be called again.

### ♻️ Changed

#### tooling

- The quickstart test runs `okm push`, and `okm generate` followed by `okm migrate apply`, against Postgres in the postgres job.
- The Release workflow publishes only from the tag `v` plus the `package.json` version, and the message names that tag when it refuses.
- Supported Postgres majors are 15, 16, 17, and 18. 13 is past end of life, 14 ends in November 2026, and 15 is the floor. A pull request runs the suite on 15 and 18 and the tarball job on 18. The release and a weekly run cover every supported major for both, and the release waits for that matrix and for a fresh install of the packed tarball. A file that cannot run on the topology is named, with the reason, in one list.
- CI runs on a pull request and on a push to main, so a pushed branch with a pull request runs once. A newer run cancels the older one on the same ref.
- The topology no longer rewrites passwords for Postgres 13. Replication still uses scram-sha-256, the server default from Postgres 14 on.
- After publish, a smoke install of that version from npm runs the quickstart against Postgres and fails when the version or its provenance is missing. The GitHub Release notes are the matching changelog section. Third-party actions are pinned by commit SHA, and two releases cannot run at the same time.
- npm metadata now has a description, keywords, a homepage, and a bugs URL.
- A pull request that cuts one bare version to the next, with the notes under the new `## vX.Y.Z` heading, is accepted with an empty Unreleased section.

#### docs

- The README and the package description say okmodel is catalog-first and PostgreSQL first, that version 0.1 supports PostgreSQL only, and that the schema is the single source for migrations and queries. A table of contents and a 0.1–0.5 roadmap replace the limits table. Size keeps the runtime entry, app startup, and cold import.

### 🐛 Fixed

- `find` with a to-one `include` returned null for the related row when that table had no primary key. The first projected column is the presence check in that case.
- Identity columns failed in `okm push` and `okm generate` and are fixed.
- A script that never calls `close()` exits after its last query. A plain postgres.js pool unrefs its sockets and does not start the idle timer. A process that stays up keeps its connections. A pool opened with `ssl` still uses the driver's socket and the 30 second idle timer.

## v0.1.0 — 2026-10-03

### ✨ Added

#### contracts

- `sha256` is a pure-TypeScript SHA-256 in the contracts layer. Fixture hashes use it.
- Catalog objects share one envelope: kind, identity, owner, definition, dependencies, and provenance. Tables, columns, indexes, constraints, sequences, and enum types are built here. Views, functions, triggers, extensions, roles, grants, and default privileges use the same envelope.
- An enum is a catalog object of kind `type`. Identity is `(namespace, name)`. The definition is the ordered label list, and that order is part of the catalog hash. Each column that uses the enum depends on the type.
- Constraint and index names are generated from a stable key. A name past the dialect limit keeps a SHA-256 suffix. Renaming a field does not rename those constraints or indexes.
- A catalog serialises to canonical JSON with a version field. The hash is SHA-256 of that JSON, so the same catalog yields the same bytes on every runtime. Namespace templates stay templates. The hash and the serialised text are computed on first use.
- `loadTrustedCatalog` checks the stored hash and version, then trusts the objects. It does not rebuild the catalog. `parseCatalog` stays the validating read.
- A declared rename rewrites identifier references inside check expressions, index predicates, and generated expressions. String literals stay as written. Constraint and index names stay.
- The driver contract is types only: `open` returns a pool with `execute`, atomic `batch`, `reserve`, `stats`, and `close`. Optional `stream`, `describe`, `listen`, and `cancel` follow capability flags. `DriverError` carries the server fields, `kind` (`timeout`, `cancelled`, or `outcome_unknown`), and `batchIndex` (`null` when the failure is the commit).
- `OkmError` carries `kind`, `category`, `summary`, `fields()`, `toHttp()`, `log()`, `retryable`, and `fix`. `safe()` returns `{ ok, value }` or `{ ok, error }`. `error.match` handles a category or `_`. `OkmError.is` narrows the kind and, for a registered table, the columns. Row values stay out of the error unless `includeValues` is set, and `log()` never prints them. `cancelled` is not retried. Every timeout is kind `timeout`. OKM1401 (`outcome_unknown`) is not retried and its fix says to check an idempotency key.
- `nearestName` suggests a close name for an unknown table, field, preset, or option. The error still lists the accepted values.

#### dialects

- `okmodel/pg` builds Postgres column types: keys, numbers, text, boolean, bytea, json, date and time, ranges, network, point and line, tsvector, ltree, enums, arrays, and `custom`. Each one compiles to a catalog column. `citext` and `ltree` record an extension dependency. `t.domain()` throws OKM1061 until 0.3.
- Codecs default to decimal strings for bigint and numeric, and to Temporal for timestamps. `t.bigint({ as: "number" })` and `t.numeric(p, s, { as: "number" })` override a field. `jsonReplacer` writes a bigint as a decimal string.
- `.picklist()` narrows a string column to a literal union and can add a CHECK. An empty list or a repeated value is OKM1060. A value outside the list is OKM1210.
- `enum` and `domain` are exported under those names. An invalid enum definition is OKM1060. `domain` throws OKM1061 and names 0.3. A label a codec rejects is OKM1210.
- Date and time codecs read the `Temporal` global. okmodel does not ship a polyfill. A missing global is OKM1210 and the message says to assign one to `globalThis.Temporal`.
- `table()` and `schema()` compile columns, references, indexes, checks, and unique constraints into a catalog. `one()` and `many()` declare relations. `manyThrough` throws OKM1061 and names 0.2. `morph` stays OKM1061 and says later. Options that arrive later throw OKM1061 and name the version (0.2, 0.3, or 0.4), or say later when no version is assigned. `schema()` defers the catalog document until `.catalog` is read.
- Postgres introspection builds a catalog from a schema. Copied partition primary keys and inherited indexes are left out. Check expressions and index predicates come back as the database's text. Enum labels are read from `pg_enum`, and a column of that type depends on it.
- `schema()` stores one type object per enum name. Columns that share the name share the object. Two different label lists for one name are OKM1020.
- The same DDL renderer plans a migration and builds a scratch schema, so a statement has one spelling.
- Tagged operators are one function per operator (`eq`, `lt`, `inList`, `or`, and the rest). An app that imports `eq` does not ship the others.
- `inc` adds to a numeric column in an `update` `set`. JSON and array operators are not in this version.
- `mapPostgresError` turns a `DriverError` into an `OkmError`. SQLSTATE picks the kind. A catalog constraint name (`{table}_{nameKey}_key`, `_fkey`, `_check`, or `{table}_pkey`) picks the column reason. `57014` without a caller abort is `timeout`.
- `Row`, `Insert`, and `Update` read a `Register` schema. `emitRowTypes` writes the same shapes (`Tasks`, `TasksInsert`, `TasksUpdate`). `schema({ types })` records `emitted` or `inferred`.

#### adapters

- `okmodel/pg/postgresjs` and `okmodel/pg/pglite` are separate entries. postgres.js and PGlite are optional peers, not dependencies of the core. One pool per endpoint. PGlite is a pool of one. Acquire timeout is OKM1846. Release runs `RESET ALL` and `pg_advisory_unlock_all()`. A timeout stays kind `timeout`. An abort from `signal` is `cancelled`. A commit whose connection dies first is kind `outcome_unknown` on `DriverError`, not an `OkmError`.
- Capability flags are readable per driver. `stream` on a driver that does not have it is OKM1111.
- `prepared: "named"` is not for transaction-mode poolers.

#### runtime

- `connect` from `okmodel/pg/postgresjs` and `okmodel/pg/pglite` returns a client typed by the schema passed in. postgres.js connects synchronously and the first query waits for the dialect check. PGlite connects asynchronously.
- Reads are `find`, `one`, `count`, and `exists`, with `where`, `select`, `orderBy`, `limit`, and `include`. A find needs a limit (OKM1101). A to-many include needs a limit (OKM1105). Includes are one LATERAL statement. `one` and `many` resolve through catalog foreign keys.
- `inspect`, `sql`, and `safe` report the plan, the statement, and `{ ok, value }` or `{ ok, error }`. Plans are cached by shape (FNV-1a, 64 entries). One endpoint until topology arrives. `stream` on a driver without it is OKM1111.
- SQLSTATE mapping and driver errors load on the first failure. The include planner loads on the first include. Checkout, describe, and stream load on first use. A successful find does not pay for them.
- Named prepared statements are opt-in (`prepared: "named"`). On a direct connection they were about 40 percent faster at p50 than unnamed. Unnamed stays the default. `prepared: "named"` is not for transaction-mode poolers.
- `insert`, `update`, and `delete` write rows. Unknown insert keys are dropped. A guarded field is OKM1190. A missing `where` is OKM1102 unless `.all(reason)`. `onConflict` is `"error"`, `"ignore"`, an update of named columns, or `{ on, return: true }`. `on` must name a unique constraint or the primary key (OKM1104). `expect` throws `not_found` when the count differs. Inserts chunk at 2048 parameters and commit together. A connection lost at commit is OKM1401 (`outcome_unknown`).
- Write planning loads on the first write. Conflict and upsert SQL loads only when `onConflict` is used. A plain insert does not load it. Hover on a row shows the field names and value types.
- `connect` reads the catalog hash from `okm_meta` in the same dialect query. Matching hashes return immediately. A database with no `okm_meta` skips the check. `connect({ requireMeta: true })` makes that missing hash OKM1520. The target name and `NODE_ENV` do not turn it on. Ahead by an expand migration is allowed. Ahead by a contract migration, or behind the code, fails with OKM1520. `loadTrustedCatalog` runs only on that mismatch, and only when `.okm/catalog.json` is present. `errors.http` is the default for `toHttp()` on errors thrown from the client. `toHttp(statuses)` replaces that default for one call.

#### tooling

- `okmodel/migrate` plans migrations. `defineConfig` lives on that entry. `okm build` validates the schema and writes `.okm/` (catalog, hash, emitted row types, and the table-name union for `references`). `okm generate` writes SQL only. `okm migrate plan <name>` prints the plan and its class. `okm check` reports a stale `renamedFrom` and a table file the schema does not import (OKM1024). Enum labels live in the catalog, not in a side file.
- An unexplained drop-and-add is OKM1530. The fix shows the line to add. The planner does not prompt.
- Removing a picklist or enum value needs `--replace table.column.old=new` (or `=null`). Without it, OKM1541's fix names the flag. The plan's expand step updates rows and keeps the old constraint; the contract step sweeps and swaps the constraint (`NOT VALID`, then `VALIDATE`). An enum removal recreates the type after that sweep: rename, `CREATE TYPE … AS ENUM`, `ALTER COLUMN … TYPE … USING`, then `DROP TYPE`. Adding a label is `ALTER TYPE … ADD VALUE`, marked non-transactional. `CREATE TYPE` is planned before the table. The type is dropped after the last column that uses it. Those data steps are plain statements. Batching them is later.
- `okmodel/testing` is reserved for 0.4 and is not an export in 0.1.
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
- The runtime-entry size gate is the measurement plus 10 percent: 6,100 minified bytes and 2,250 gzip (D144). A cold import on Node is the median of five fresh processes. CI fails above 25 ms (D134). Locally the script prints the 15 ms reference and records a finding above it.
- The 0.1 app startup budget is the startup graph after the trim: 77,524 minified bytes and 25,641 gzip, gate 79,849 / 26,410 (measured plus 3 percent, under the 86,688 / 27,800 cap). The total graph is printed and not gated. `okmodel/pg` is printed and not gated; a per-export tree-shake test and the app fixture are the gates. Connect entries stay gated on bytes (postgres.js 39,849 / 13,815, PGlite 38,146 / 13,505, measured plus 5 percent). Their cold import is printed, including a driver-stubbed sample, and is not gated. The 15 ms local reference applies to our own code with the driver stubbed. Adapter entries are gated on minified bytes that are not already in the runtime entry (postgres.js 15,093, PGlite 12,010). The app fixture's cold import is printed and is not the 25 ms CI failure. That failure stays on the runtime entry (D134), because the app runs `schema()` at import. Public subpaths are `okmodel`, `okmodel/pg`, `okmodel/pg/postgresjs`, `okmodel/pg/pglite`, `okmodel/migrate`, and `okmodel/internal`. `okmodel/testing` is reserved until 0.4 and is not exported.
- `bun run editor-check` compares hover, completions, and diagnostics from the TypeScript 6 language server with a snapshot. It also checks the row types `okm build` emits, including an enum column. TypeScript 7 has no language server, so the server is the dev-only `typescript-editor` package. It is not imported and not bundled. The check is part of `bun run check`.
- The Postgres CI job also runs the read and write tests.
- `bun run type-cost` also typechecks a find with filter, select, include, and orderBy on 10, 50, and 200 tables, against the built declarations. Instantiations stay under the D133 inferred-200 ceiling. The composite probe's own types ceiling is 7,100 (D140). The emitted-consumer measurement typechecks the row types `okm build` writes.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the harness barrel. Adapter entries must leave `postgres` and `@electric-sql/pglite` external.
- A conformance suite runs the same driver cases on either adapter: execute, nulls, timestamps, numeric, bigint, json, arrays, batch (including a savepoint inside a reserved transaction), reservation, stats, close, and session reset. Cancel, timeout, and stream run only when the adapter declares them.
- Error-mapping conformance runs on postgres.js and PGlite: unique, not-null, check, foreign key, exclusion, serialization, deadlock, lock timeout, statement timeout, cancelled, connection failure, and `batchIndex` (a number, or null at commit).
- The error registry lists every spec §21 code (`code`, `title`, `summary`, `fix`) for `okm doctor`. It is not imported by the runtime entry. OKM1111 is listed for a call the driver cannot do.
- `bun run driver-bench` times `execute` against calling postgres.js directly. It prints the median and does not enforce a ceiling.
- The Postgres CI job runs the driver conformance suite with `REQUIRE_DOCKER=1`.
- `okm migrate apply` runs each migration in one transaction where Postgres allows it. `CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, and `VACUUM` are their own steps. Every finished step writes a checkpoint in `okm_history`, with the catalog hash. A failure stops at that step and the next apply resumes. There are no down migrations. A data step runs as the statement the plan wrote.
- One session advisory lock covers the apply. A second apply fails at once with OKM1522. `lock_timeout` and `statement_timeout` are set on every step, and a lock timeout retries with backoff.
- A known pooler URL is refused unless `--allow-pooler` or `allowPooler` is set.
- Named `targets`. More than one requires `--target` (OKM1853). Two names for one database must agree on protection (OKM1852).
- A protected target allows read-only commands and expand. Contract, unclassified, push, backfill, seed, and history repair need `--allow-protected`. Drop and rollback stay refused. `push` is refused only when the target sets `protected`. A target named `production` is not special; production targets must set `protected`.
- `okm migrate status` reports each target's version, catalog hash, state (current, behind by expand, behind by contract, ahead, failed at a step), and whether it is protected.
- `okm push` applies the current plan as a prototype sync. `okm dev` starts a local PGlite database in `.okm/dev-db` when no target named `dev` is configured.
- The Postgres CI job also runs the apply tests.
- An API snapshot fails CI when a public subpath gains or loses an export. Each export is classified stable, experimental, or internal.
- The per-export tree-shake check fails when one `okmodel/pg` export keeps an unrelated module.
- A quickstart test packs the tarball, installs it in a fresh project, and runs the commands in the quickstart doc: `okm build`, `okm generate`, and `okm migrate apply`, then the read and write calls.
- The compatibility table is generated from the conformance run on postgres.js and PGlite.

#### docs

- The M0 gate findings are in `docs/m0-findings.md`, with a Resolved by column for each row.
- Spec section 21 records OKM1026 for a catalog dependency cycle and OKM1027 for a catalog document this version cannot read.
- `docs/editor-check.md` describes the language-server snapshot for row hover, column completion, and a missing column or table, and the same check on emitted row types.
- The quickstart, production checklist, environment recipes, known limits, measured size, API classification, compatibility table, and the 0.1.0 release checklist.

### ♻️ Changed

#### contracts

- Catalog serialisation, parsing, hashing, rename, and dependency order are no longer on the runtime entry. They stay in the catalog document module for tooling.
- `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders move to `okmodel/internal`. `okmodel` keeps `OkmError`, `safe`, the row types, and the driver types. `table` and `index` for a schema are `okmodel/pg`.
- SHA-256 round constants and the reserved-word set are built on first use. UTF-8 length and encoding share one helper. An ordering pass computes each identity key once.
- Catalog errors name the accepted value.
- A foreign key whose column type does not match its target is OKM1022. Foreign keys store `onDelete` and `onUpdate`.
- A table or schema option that the types accept but this version does not implement is OKM1061. OKM1060 stays an invalid column definition.
- A catalog dependency cycle is OKM1026. A catalog document this version cannot read is OKM1027. OKM1020 stays the code for an unknown table.
- An invalid column definition is OKM1060. A value a codec rejects is OKM1210. Messages name the accepted values.

#### dialects

- `schema()` builds the query model immediately and defers catalog object construction until `.catalog` is read.

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
- Cold import fails on CI above 25 ms (D134). A local sample above the 15 ms reference is printed as a finding and does not fail the script.
- The runtime-entry gate is measured plus 10 percent (6,100 minified bytes, 2,250 gzip). The 25 ms CI cold-import gate stays on that entry. App startup and connect gates stay.
- `dist/` size is reported and no longer fails the check (D135). `size-budget.json` is removed. Adapter entries are gated on minified bytes that are not already in the runtime entry, so shared code is not counted twice.

#### docs

- The package description names typed queries, safe migrations, and replica-aware routing. The README is the 0.1 install note.
- Changelog area headings are the layer names: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.
- Normative docs match spec draft 22 and decisions D1–D143. The spec lists builders and options that throw OKM1061, and it says a production target must set `protected`. The spec registry names OKM1026, OKM1027, OKM1060, OKM1061, and OKM1210.
- The quickstart test runs the commands in `docs/quickstart.md`, including `okm migrate apply`. Production and preview `apply` run in CI. Creating a preview database, seeding, deploying, deleting it, and cloning production for rehearsal do not: those steps are infrastructure, and CI has no production clone.
- `okmodel/internal` has no stability promise. The README and the known-limits page say so, and its exports are marked `@internal`.
- `docs/release.md` includes starting the Release workflow from the GitHub Actions page on the `v0.1.0` tag, next to the `gh` command.
- Engineering standards (D129) are in `AGENTS.md` and the ship skill. Reports state runtime entry size, cold import, and type-cost change.

### 🐛 Fixed

#### dialects

- `schema().catalog` accepts an enum column. It no longer raises OKM1020 because the enum type was missing from the catalog.

#### runtime

- Inside `insert({ ... })`, completions list the property under the cursor and every insertable column not already written. Optional columns are optional keys. A guarded column, or one insert omits, stays out. One row stays one row.

#### docs

- `docs/editor-check.md` records that insert completions include the unfilled insertable columns.

### 🔥 Removed

- The M0 spike implementations are deleted. They remain on the `m0-spikes` tag. Findings stay in `docs/`. The row-type and operator fixtures remain so the type ceilings can be measured.
- The empty `okmodel/testing` export. The name is reserved until 0.4.
- Internal helpers leave the public subpaths. `okmodel/pg` no longer exports `compileColumn`, `emitRowTypes`, `mapPostgresError`, or the operator tag helpers. `okmodel/migrate` exports `defineConfig`, `MigrateConfig`, and `TargetInput`. The CLI imports its helpers from the package.
