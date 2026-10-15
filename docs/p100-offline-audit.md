# P100: PostgreSQL audit of the offline-first constraints

Report only. It follows [`offline-first-constraints.md`](offline-first-constraints.md) and D265 and does not change them. No feature was built.

Earlier audit reports live in `docs/` itself, not a subdirectory. The P80 budget audit is a section of [`size.md`](size.md). M0 findings are [`m0-findings.md`](m0-findings.md). This file is the same place.

Base: `d528978` (`0.8.0-next.1`). Each conclusion uses one label:

- **existing and proven** — the behavior exists and the named test runs it.
- **existing partially** — a type, API, or mechanism exists; the guarantee or the coverage is incomplete. A type with no test is this label.
- **absent or needs a decision** — a gap. The decision is listed at the end and is not taken here.

## R1. What a consumer can read today

The application schema surface is `okmodel/pg` ([`docs/api.md`](api.md), checked by [`tests/api-surface.test.ts`](../tests/api-surface.test.ts) against [`tests/fixtures/api-surface.json`](../tests/fixtures/api-surface.json)). `schema()` returns `catalog`, `model`, `codecs`, `casing`, `types`, and `requires` ([`src/dialects/pg/schema.ts`](../src/dialects/pg/schema.ts)). There is no second description and no export that serializes the logical schema.

| Concern | Label | Evidence |
| --- | --- | --- |
| Single-column and composite primary keys | **existing and proven** | `table({ primaryKey })` is compiled into a catalog constraint and `model.primary`. [`tests/pg-schema.test.ts`](../tests/pg-schema.test.ts) (`a column primary key and a composite key are catalog constraints`). Real Postgres: [`tests/drift-pg.test.ts`](../tests/drift-pg.test.ts), [`tests/migrate-pg.test.ts`](../tests/migrate-pg.test.ts). |
| Relations (`one`, `many`, `manyThrough`, morph) | **existing partially** | Public helpers in [`src/dialects/pg/relations.ts`](../src/dialects/pg/relations.ts). `schema()` stores them on the runtime `TableModel`, not in the catalog. The catalog stores the foreign key, which the key test above proves. A consumer that reads only the catalog does not get relation names. |
| Column types | **existing and proven** | `ColumnDefinition.dataType` is in the hashed catalog ([`src/contracts/catalog/types.ts`](../src/contracts/catalog/types.ts)). [`tests/client-id.test.ts`](../tests/client-id.test.ts) checks `text` and `uuid`. |
| Codecs | **existing partially** | `schema({ codecs })` chooses `bigint`, `numeric`, and `timestamps` ([`src/dialects/pg/schema.ts`](../src/dialects/pg/schema.ts)). Encode and decode are functions on the column model. There is no stable codec identity or codec version. |
| Database defaults | **existing and proven** | A literal `.default()` is stored as `defaultExpression`. [`tests/client-id.test.ts`](../tests/client-id.test.ts) (`a literal default stays in the catalog and a function does not`). A bare `t.id()` stores `gen_random_uuid()` (D262), same test file. |
| Client id rules as data | **existing partially** | `uuidv4`, `uuidv7`, and `okid` from `okmodel/ids` fill the column on insert. The catalog stores no generator name, prefix, or length. The runtime model keeps the function. See the identification row below. |
| Logical schema version | **absent or needs a decision** | `CATALOG_VERSION` is `1`, the catalog document format, exported from `okmodel/internal` ([`src/contracts/catalog/types.ts`](../src/contracts/catalog/types.ts)). It does not change when the schema changes. The catalog hash is equality, not a version. |

**`okmodel/internal`.** **existing and proven.** It exports `sha256`, `throwNamed`, `nearestName`, `catalogError`, `CATALOG_VERSION`, and the catalog builders (`table`, `column`, `constraint`, `index`, and the rest) ([`src/contracts/internal.ts`](../src/contracts/internal.ts)). [`tests/api-surface.test.ts`](../tests/api-surface.test.ts) requires `@internal` on those exports. [`docs/api.md`](api.md) and [`docs/known-limits.md`](known-limits.md) state that the subpath has no stability promise. Application keys, relations, and column builders are `okmodel/pg`, not this entry.

**What is not serializable, and how it is identified.**

| Value | Label | How it is identified |
| --- | --- | --- |
| Client generator (`uuidv4`, `uuidv7`, `okid`, or any other function passed to `.default()`) | **existing and proven** | Marked with the `CLIENT_DEFAULT` symbol in [`src/contracts/generator.ts`](../src/contracts/generator.ts). Named generators keep `uuidv4`, `uuidv7`, or `okid`. Any other function is named `function`. The catalog column has no `defaultExpression`. [`tests/client-id.test.ts`](../tests/client-id.test.ts) proves a function is absent and that changing an okid prefix, length, or `sortable` flag does not change the hash. The type and collation the generator forces are in the hash: okid is `text` with collation `C`. |
| `defaultSql(expression)` and `sql` check text | **existing partially** | Stored as a string (`defaultExpression`, check text) and hashed. Nothing marks the string as database-specific or non-portable. A consumer cannot tell `gen_random_uuid()` from a portable literal by a flag. |
| Encode, decode, relation resolvers, schema hooks, validation functions | **existing partially** | They are functions on the runtime model. They are omitted from catalog JSON because catalog objects have no function fields. There is no explicit "not client-compatible" mark. |

## R2. Transactions

All four drivers declare `transactions: "interactive"` ([`src/adapters/capabilities.ts`](../src/adapters/capabilities.ts)). [`tests/tx-suite.test.ts`](../tests/tx-suite.test.ts) registers postgres.js, node-postgres, PGlite, and Bun.sql. The cases are in [`packages/harness/src/tx-suite.ts`](../packages/harness/src/tx-suite.ts). Bun.sql is registered only when `Bun.SQL` exists. PGlite skips a case that needs a second connection (`one connection`) or a TCP cut (`no socket to cut`). A skip is not proof.

| Behavior | postgres.js | node-postgres | PGlite | Bun.sql |
| --- | --- | --- | --- | --- |
| Atomic `batch` of ORM writes | **existing and proven.** `postgres.js batch is atomic and returns results in order` | **existing and proven.** `node-postgres batch is atomic and returns results in order` | **existing and proven.** `pglite batch is atomic and returns results in order` | **existing and proven.** `bun.sql batch is atomic and returns results in order` |
| Interactive `tx` | **existing and proven.** `postgres.js tx commits its writes and returns the callback's value` | **existing and proven.** `node-postgres tx commits its writes and returns the callback's value` | **existing and proven.** `pglite tx commits its writes and returns the callback's value` | **existing and proven.** `bun.sql tx commits its writes and returns the callback's value` |
| Nested savepoint | **existing and proven.** `postgres.js a nested tx is a savepoint: the inner failure rolls back only the inner writes` | **existing and proven.** `node-postgres a nested tx is a savepoint: the inner failure rolls back only the inner writes` | **existing and proven.** `pglite a nested tx is a savepoint: the inner failure rolls back only the inner writes` | **existing and proven.** `bun.sql a nested tx is a savepoint: the inner failure rolls back only the inner writes` |
| Rollback | **existing and proven.** `postgres.js tx rolls back on a throw and the caller's own error comes back as thrown` | **existing and proven.** `node-postgres tx rolls back on a throw and the caller's own error comes back as thrown` | **existing and proven.** `pglite tx rolls back on a throw and the caller's own error comes back as thrown` | **existing and proven.** `bun.sql tx rolls back on a throw and the caller's own error comes back as thrown` |
| Affected rows | **existing and proven.** The same batch test expects the update result `{ count: 1 }` | **existing and proven.** Same test, `{ count: 1 }` | **existing and proven.** Same test, `{ count: 1 }` | **existing and proven.** Same test, `{ count: 1 }` |
| `outcome_unknown` when COMMIT is cut | **existing and proven.** `postgres.js a commit cut on the wire is outcome_unknown (OKM1401) and is never retried` and `postgres.js a batch whose commit is cut is outcome_unknown with a null batchIndex` | **existing and proven.** The same two titles with the `node-postgres` prefix | **absent or needs a decision.** Those two tests are skipped: `no socket to cut`. No other PGlite COMMIT-loss test | **existing and proven.** The same two titles with the `bun.sql` prefix |

Driver-level atomicity of arbitrary statements is a second suite, [`packages/harness/src/driver-suite.ts`](../packages/harness/src/driver-suite.ts), registered by [`tests/driver-suite.test.ts`](../tests/driver-suite.test.ts). `batch commits every statement`, `batch rolls back a failure at each position`, and `runs a batch inside a transaction on a savepoint` pass on all four drivers. Those statements are `INSERT` and `SELECT`, not DDL.

**What `batch()` guarantees.** **existing and proven** for this scope: the public `db.batch()` plans ORM write handles only (`insert`, `update`, `delete`, `archive`) and runs them as one atomic unit ([`src/runtime/batch.ts`](../src/runtime/batch.ts)). Anything else is OKM1121. The tx suite proves the refusal: `batch refuses .replica() (OKM1840) and anything that is not a write`, on all four drivers. `refresh()`, `restore`, a write with `expect`, and an update that sets a path column are also refused. Inside `tx()` the unit is a savepoint (`batch inside tx is a savepoint: a failing batch can be handled and the tx survives`, all four drivers).

**Any SQL, DDL included.** **existing partially.** `DriverPool.batch` runs the statement text it is given inside `BEGIN` / `COMMIT`, or a savepoint when a transaction is open ([`src/adapters/pg/batch.ts`](../src/adapters/pg/batch.ts), D124). The driver suite proves that for DML. No test puts DDL in the batch, and public `batch()` will not accept it. There is no universal atomicity claim beyond that wrapper.

Insert results are the returning rows, not `{ count }`. Update, delete, and archive return `{ count }` from `ExecuteResult.count` ([`src/runtime/write.ts`](../src/runtime/write.ts)). Delete and archive `{ count }` are proven on postgres.js in [`tests/archive-pg.test.ts`](../tests/archive-pg.test.ts), not repeated on the other three drivers. That cross-driver cell stays the update count above.

## R3. Primary keys and client-generated ids

Generators are `uuidv4`, `uuidv7`, and `okid` ([`src/runtime/ids/index.ts`](../src/runtime/ids/index.ts)). `fillInsert` runs when the insert is planned, before the statement is sent ([`src/runtime/write.ts`](../src/runtime/write.ts)).

| Item | Label | Evidence |
| --- | --- | --- |
| A client generator fills the id before insert | **existing and proven** on PGlite | [`tests/client-id.test.ts`](../tests/client-id.test.ts) (`insert fills each row and connect can replace the generator`) returns the filled `uuidv4`, `okid`, and `uuidv7` ids. postgres.js, node-postgres, and Bun.sql use the same planner and have no generator-fill test: **existing partially** for those three. |
| Composite primary keys | **existing and proven** | Catalog and model in [`tests/pg-schema.test.ts`](../tests/pg-schema.test.ts). Applied on Postgres in [`tests/drift-pg.test.ts`](../tests/drift-pg.test.ts) and [`tests/migrate-pg.test.ts`](../tests/migrate-pg.test.ts). The columns are caller-supplied (`writable`, `guardUpdate`). There is no client generator for a composite key as a whole. |
| Repeated insert of the same id, postgres.js `onConflict` | **existing and proven** | [`tests/insert-rows-pg.test.ts`](../tests/insert-rows-pg.test.ts) (`conflict handling and validation take rows with different keys`) runs `onConflict: "ignore"`, `{ on, update }`, and `{ on, return: true }` through postgres.js. |
| Repeated insert, conflict code, per driver | **existing partially** | `23505` maps to kind `unique` in [`src/dialects/pg/errors.ts`](../src/dialects/pg/errors.ts). [`tests/error.test.ts`](../tests/error.test.ts) maps a constructed `DriverError`. [`tests/constraint-name-pg.test.ts`](../tests/constraint-name-pg.test.ts) maps a real duplicate insert executed as raw SQL on postgres.js. [`tests/archive-pg.test.ts`](../tests/archive-pg.test.ts) sees kind `unique` on a restore conflict, postgres.js only. No test inserts the same primary key twice through the ORM on node-postgres, PGlite, or Bun.sql. |
| The same client-generated id on a retried write | **absent or needs a decision** | A client-generator `t.id()` is `guarded` and `omitWrite` ([`src/dialects/pg/keys.ts`](../src/dialects/pg/keys.ts)). Supplying the id is OKM1190. [`tests/client-id.test.ts`](../tests/client-id.test.ts) proves that refusal on PGlite. `{ allow }` can name a guarded field in `writable()`, and that path is not tested for ids. A database default (`gen_random_uuid()`, `uuidv7()`) is assigned by the server on each insert. No test retries one write and checks that the id is unchanged. |
| The id after a re-run transaction callback | **existing partially** | The callback runs again on serialization failure and on deadlock. Proven on postgres.js, node-postgres, and Bun.sql: `two serializable transactions that conflict: the loser is retried on a fresh transaction` and `a real deadlock: the victim is retried and both finish`. PGlite skips both (`one connection`): **absent or needs a decision** for that driver. The proven retries update existing ids `a` and `b`. They do not insert a generated id. Each attempt calls the callback from scratch ([`src/runtime/transaction.ts`](../src/runtime/transaction.ts)), so a generator planned inside the callback runs again. That new id is not tested. `outcome_unknown` is not retried (the COMMIT-cut test expects `runs` to stay 1). |

A caller-supplied key on a column that is not a client generator (composite columns, `t.id({ default: "none" })`) is just a value in the insert object. Nothing regenerates it. No test closes over that value and retries.

## R4. Conformance matrix

**existing and proven** for the driver table that exists. [`docs/compatibility.md`](compatibility.md) is generated from [`tests/driver-suite.test.ts`](../tests/driver-suite.test.ts) and [`tests/error-suite.test.ts`](../tests/error-suite.test.ts). It covers postgres.js, node-postgres, Bun.sql, and PGlite on Postgres 15, 16, 17, and 18: wire values, batch commit and rollback, cancel, notices, and SQLSTATE mapping. It is one dialect.

**absent or needs a decision** for the matrix R4 names. Nothing records a behavior as same, differs, or unsupported across dialects. SQLite and MySQL are not in the repository. The transaction suite above is a second matrix and is not copied into `compatibility.md`. This audit does not build the matrix.

## R5. Two identities

**existing and proven.** `catalogHash` is SHA-256 of the canonical catalog JSON, including `version` ([`src/contracts/catalog/document.ts`](../src/contracts/catalog/document.ts)). Client generators are outside it ([`tests/client-id.test.ts`](../tests/client-id.test.ts)). `startupHash` is what `connect()` and `okm_meta` use. Roles and grants change `catalogHash` and do not change `startupHash` ([`tests/roles.test.ts`](../tests/roles.test.ts), `the startup hash leaves roles out, and a catalog without roles hashes as before`). Stamped `ignored` ownership does not change `startupHash` ([`tests/access.test.ts`](../tests/access.test.ts), `ignored and external tables are not created, altered, or dropped`). `minPostgres` is not a catalog object (D261). Database default expressions are inside the hash.

**existing and proven** for what `okm_meta` stores. The head row is `id`, `catalog_hash`, `migration_id` ([`src/tooling/migrate/apply.ts`](../src/tooling/migrate/apply.ts)). [`tests/roles-pg.test.ts`](../tests/roles-pg.test.ts) reads `catalog_hash` from `okm_meta` and from `okm_history`. `okm_history` stores `migration_id`, `step_index`, `class`, `catalog_hash`, `applied_at`. `okm_backfill` stores backfill progress. Migration files are applied in name order, each with a sibling catalog snapshot ([`src/tooling/migrate/files.ts`](../src/tooling/migrate/files.ts)).

**absent or needs a decision** for same / older / newer / diverged. Drift compares two hashes and reports equal or not (OKM1520). The applied history can say which migration id was applied. It cannot, by itself, say that one catalog is an ancestor of another or that two catalogs diverged. No schema-version list defines those states. Pending operations across upgrades stay with the OKEngine runtime, as R5 already says.

## R6. Consumer writes in the same transaction

Not added. P106 owns the test. Description:

A schema with no tenancy registers two tables, both through `table()` in the same `schema()` call. One is the domain table (`notes`). One is the consumer-owned table (`outbox`), with a caller-supplied primary key. `connect` applies the catalog. Inside `db.tx()`:

1. Commit. Insert a note and an outbox row. Read both back after the callback returns. Both rows are present.
2. Rollback. Insert both, then throw. After the rejection, neither row is present.
3. Nested savepoint. Insert the note in the outer callback. In a nested `tx()`, insert an outbox row and throw. The outer callback inserts a second outbox row and returns. After commit, the note and the second outbox row are present, and the inner outbox row is not.

The writes are `tx.notes.insert` and `tx.outbox.insert`. The nested call is `tx.tx()`.

**existing partially** for the mechanism this test would use. `TxClient` is the same table API as the caller, including tenancy and archive handling ([`src/runtime/transaction.ts`](../src/runtime/transaction.ts), [`src/runtime/types.ts`](../src/runtime/types.ts)). The tx suite already commits, rolls back, and savepoints two tables that the suite itself registered (`accounts`, `events`). It does not register a second party's table beside a domain write.

Nothing in `tx()` blocks that test when the schema has no tenancy. Typed access is the table name on the callback client. There is no raw SQL method on the client, so an unregistered table cannot be written this way (known limits: OKM1702 is not thrown because no public call takes raw SQL).

Tenancy is a condition, not a block, if the schema has it. Column tenancy rewrites every table that is not `tenancy: global("reason")` into a tenant table. The root client type omits tenant tables until `for()` (`RootName` in [`src/runtime/types.ts`](../src/runtime/types.ts)). The scope sets the tenant key; input that sets it is OKM1190. A global consumer table stays on the root `tx()`. A tenant consumer table is written on `db.for(tenant).tx()`. The P106 test should use a schema with no tenancy so that condition stays out of the proof.

## The five claims next to D265

These are the current-state claims recorded in [`offline-first-constraints.md`](offline-first-constraints.md) with D265. Each one is confirmed or corrected.

1. **Client generators sit outside the catalog and its hash.** Confirmed. [`tests/client-id.test.ts`](../tests/client-id.test.ts). Correction of scope: the generator function and its options are outside the hash. The column type and collation they imply are inside it. Okid is `text` with collation `C`, and changing those would change the hash. Changing the prefix does not.
2. **`okmodel/internal` has no stability promise.** Confirmed. [`docs/api.md`](api.md), [`docs/known-limits.md`](known-limits.md), [`tests/api-surface.test.ts`](../tests/api-surface.test.ts).
3. **`docs/compatibility.md` covers drivers and Postgres versions and is not the dialect matrix.** Confirmed. It is a driver-by-case table for Postgres 15–18. The transaction suite is not in that file. R4's same / differs / unsupported matrix does not exist.
4. **A hash says equal or not equal. It cannot say older, newer, or diverged. `okm_meta` stores the applied head.** Confirmed. `startupHash` compared with `okm_meta.catalog_hash` (D208). The head row is `catalog_hash` and `migration_id`. `okm_history` stores applied steps and does not classify two catalogs.
5. **A consumer-owned table registered in the client schema can share `tx()` with a domain write, and that is not proven.** Confirmed. The callback client exposes every registered table. The tx suite proves commit, rollback, and a nested savepoint for its own tables. No test registers a consumer table beside a domain write. Tenancy does not block the unscoped test described in R6. It does hide tenant tables on the root client until `for()`.

## Decisions for later phases

Not taken here.

| Decision | Owner |
| --- | --- |
| Logical serializable description: keys, relation names, a codec identity and version, client id rules, and an explicit mark for database-specific expressions. No second sync schema. | 0.9, on `okm catalog export` and the programmatic schema API |
| Classify two catalogs as same, older, newer, or diverged from migration lineage or a schema-version list. The hash stays equality. | 0.9 |
| Dialect matrix: each behavior same, differs, or unsupported, with a test id. No silent emulation. | M3 starts the matrix. M4 carries its own R2, R3, and R4 rows as part of dialect done |
| Driver rows still open on PostgreSQL: COMMIT loss on PGlite, the repeated-insert outcome on node-postgres, PGlite, and Bun.sql, and whether a client-generated id is allowed to survive a retried callback. Today a client-generator id cannot be supplied (OKM1190) and a re-run callback plans a new one. | 0.8 P106, as conformance rows. The allow-path proposal is below. Ali decides. Nothing is built for it |
| The R6 integration test in the previous section. | 0.8 P106 |

## P106. What the command records

`okm driver test` runs the existing driver, error-mapping, and transaction suites and prints each case as `pass`, `fail`, or `unsupported`. The dialect in the report is `postgres`. A row is a case id, the behavior, and the driver result. An unsupported row names the capability.

R6 is `r6.commit`, `r6.rollback`, and `r6.savepoint`: a `notes` table and an `outbox` table in one `schema()`, written with `tx.notes.insert` and `tx.outbox.insert`. Commit keeps both. Rollback keeps neither. A nested `tx.tx()` that throws rolls back only the inner outbox row. The schema has no tenancy.

R3 repeated insert is `r3.repeat-insert` (`23505`, kind `unique`), `r3.on-conflict-ignore`, `r3.on-conflict-update`, and `r3.on-conflict-return`. R3's current id rule is `r3.retry-id` (a re-run callback plans a new client-generated id; PGlite is `unsupported` because of `one connection`) and `r3.supply-id` (a caller cannot supply one, OKM1190).

R2 COMMIT loss stays the transaction suite's cut cases. On PGlite they are `r2.commit-loss` and `r2.batch-commit-loss`, result `unsupported`, capability `no socket to cut`. The same sentence is in [`compatibility.md`](compatibility.md).

R4's shape, for this one dialect, is that row: case id, behavior, driver result. SQLite and MySQL are not in the report.

### Caller-supplied client id (proposal only)

A caller-supplied id on a client-generator column stays refused (OKM1190) unless the call opts in. The starting point is the `{ allow }` list that already names a guarded field: `insert({ id }, { allow: ["id"] })`.

1. Without `allow`, supplying the id stays OKM1190. The generator still fills an omitted id.
2. With `allow` naming that field, the call writes the supplied id and does not run the generator for that row. A row in the same list that omits the id still gets a generated one.
3. An id the caller holds outside the callback stays that id across a serialization or deadlock retry. An id generated inside the callback is a new id on each attempt. That is today's behavior, and it stays when `allow` is absent.
4. Inserting that same id again is a conflict (`23505`, kind `unique`) unless `onConflict` is set. `allow` does not make the repeat idempotent.
5. `allow` does not apply to a database default (`gen_random_uuid()`, `uuidv7()`). The server still assigns those.

Ali decides. This step builds none of it.

## Count

Each bold label in the sections above is one conclusion. The definitions at the top are not counted.

| Label | Count |
| --- | --- |
| existing and proven | 35 |
| existing partially | 10 |
| absent or needs a decision | 6 |

Twenty-three of the proven conclusions are R2 cells (four drivers for batch, `tx`, savepoint, rollback, and affected rows, and three drivers for COMMIT loss). The other twelve are keys, types, database defaults, the generator mark, `okmodel/internal`, the public `batch()` scope, the PGlite generator fill, composite keys, postgres.js `onConflict`, the compatibility document, the catalog hash, and `okm_meta`. The ten partial conclusions are relations, codecs, client id rules as data, unmarked SQL strings, runtime functions, arbitrary SQL in the driver batch, generator fill on the three drivers without a fill test, the per-driver repeat-insert conflict, a re-run callback that does not check the id, and the unproven consumer-table mechanism. The six gaps are a logical schema version, PGlite COMMIT loss, a stable client-generated id across a retried write, PGlite serialization and deadlock retry, the dialect matrix, and older / newer / diverged. The R6 test is described and not counted as a fourth label: it is the last gap's owner, P106, and the mechanism row is the partial conclusion.
