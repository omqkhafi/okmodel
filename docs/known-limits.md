# Known limits

What `0.2.1` does not do, or does differently from what you might expect. Each item says what happens, so none of them is a surprise at runtime. A limit that has a version is listed in the release train in [`okmodel-execution-plan.md`](okmodel-execution-plan.md). `later` means the plan has not assigned a 0.x release.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release. Its exports are marked `@internal`.

## Not built yet

An option or builder that is not in 0.2 throws OKM1061 and names the prompt or version that adds it, or it is not a method yet. These are the ones the plan has assigned.

| Item | Version | Prompt |
| --- | --- | --- |
| `t.domain` | 0.3 | P40b |
| functions | 0.3 | P41 |
| triggers | 0.3 | P41 |
| views | 0.3 | P42 |
| `reference` | 0.4 | P53A |
| `okmodel/testing` | 0.4 | P54 |
| `morph` | later | M2 |
| `computed` | later | no 0.x prompt |
| `policies` | later | no 0.x prompt |

Installing the head snapshot, snapshot-versus-replay equivalence (OKM1521), and `reference` rows arrive in P53A. In 0.1 and 0.2, `okm migrate apply` replays migration files. See [environments](environments.md).

Also not in 0.2:

- **`rls` tenancy is not built.** Column tenancy is the only strategy. Inside `tx()` the tenant is the column predicate on every statement (D181).
- **Three registered codes are not thrown in 0.2** (D183). OKM1110 (a feature needs a newer engine than `requires`): the one engine-dependent feature, `uuidv7()`, fails as OKM1812 when the schema is built with `requires` below 18, and `okm migrate apply` raises it before any statement when the server is older than 18 (D184). OKM1191 (no snapshot plan inside READ COMMITTED): every read is one statement, so a plan always exists. OKM1702 (unverifiable raw SQL on a tenant table): no public call takes raw SQL; typed raw SQL is M2.
- **`okm ext test` and `okm ext scaffold` are not built.** `okm ext list` prints the extensions the connected server can install and the version that is installed. `okm ext check` compares those versions with the schema. The conformance suite and the scaffold are later.
- **JSON Schema export is absent.** `insert` and `update` are Standard Schemas; they do not emit JSON Schema.
- **`onRead` is stored and not applied.** `validation: { onRead: true }` is accepted and read values are not validated.
- **`iStartsWith`, `iContains` and `iEndsWith` are not in 0.2** (D176). Use `ilike()` with an escaped pattern.
- **`aggregate()` has no `having` and no `bucket`** (M2).
- **Batch-mode drivers have no adapter yet.** Neon HTTP and Cloudflare D1 are covered by the driver contract (`batch` is required on every driver) and there is no adapter in this repository for either.

## Safety and tenancy

- **A unique that a trait adds after the tenancy rewrite is not widened** (D168). `columnTenancy().rewrite()` runs first and widens uniques the table already declared. Trait `apply` runs after that, so a unique introduced by the trait stays on the trait's columns only. `timestamps()` adds no unique. `archivable()` adds no unique either: it turns uniques that already exist into partial unique indexes (`WHERE archived_at IS NULL`) after the rewrite, so a tenant unique stays `(tenant key, column)` with that predicate. The primary key stays a full constraint.
- **Archive cascades to direct children only.** `archivable({ cascade: ["projects"] })` archives the active projects of an archived org in the same statement, with the same `archiveId`. It does not archive the tasks of those projects. A grandchild stays active under an archived parent until you archive it, or until its own parent has `cascade` for it. Restore follows the same rule: it restores the children that share the row's `archiveId`.
- **A table named `tx` or `batch` is shadowed.** On the client, `db.tx` and `db.batch` are the methods. A table with either name is unreachable by that property; rename the table.

## Reads and types

- **`sum` and `avg` over a `text` column pass the types and fail when the call runs (OKM1124).** The row types cannot tell a `numeric` string from a `text` string.
- **`bigint` as `bigint` aggregates are refused (OKM1124).** `sum` and `avg` over a `bigint` column that reads as a JavaScript `bigint` do not run (the total has no honest `bigint` type). Map the column as a string or a number, or read the rows and add them in the application. `min` and `max` work.
- **Some intervals and times cannot be read.** An `interval` that mixes signs, such as `1 day -01:00:00`, cannot be one `Temporal.Duration`, so a read that selects it fails with OKM1210. The decoders take the default `IntervalStyle` (`postgres`) and ISO-8601; `sql_standard` and `postgres_verbose` output is not read, and that is OKM1210 too. A `timetz` with a seconds offset such as `+05:30:15` is OKM1210 (D179).

## Transactions, cancellation and batch

- **`idleInTransaction` is a client-side timer,** not the server's `idle_in_transaction_session_timeout`. The client fails the transaction when it has sat idle that long; the server setting is untouched.
- **On PGlite and Bun.sql a `tx` timeout or signal cannot kill a statement waiting on a lock.** The callback is released and the rollback queues behind the waiting statement. PGlite has one connection and no `cancel`; Bun.sql has no `cancel` on Bun 1.4 (D181).
- **Bun.sql has no notices.** It does not surface `RAISE NOTICE`, so `hookm.onNotice` never fires on `okmodel/pg/bun`.
- **`restore` and any write with `expect` are not allowed in `batch`** (D183). Both are checked against the result of their statement, and a batch cannot report that after it commits. A batch that holds either is refused with OKM1121 before any statement is sent, with the error naming `tx()`. Use `tx()` for them. A statement the database refuses (a unique, a foreign key, a check) still rolls the whole batch back.
- **The types still accept `restore` and `expect` inside `batch`; only the runtime refuses them** (D184). Narrowing the types so the compiler refuses both was measured in 0.2.1 and not built: refusing the `{ expect }` option takes a second overload on every write method, which moved the `query-200-validate` probe from 25,047 to 27,366 instantiations against a ceiling of 25,631. A `restore` or a `.expect()` call on its own costs +2 / +1 on every probe; the option form is the part that does not fit.

## Drivers

A postgres.js pool opened with `ssl` still uses the driver's socket and its 30 s idle timer (D152). Measured on Postgres 17 with TLS 1.3, one query, and no `close()`: the process exited in 30.10 s on Bun and 30.07 s on Node 26. A plain pool (no `ssl`) exits on its own. `close()` or `await using` releases a TLS pool without waiting.

node-postgres sets `allowExitOnIdle` and `idleTimeoutMillis: 0`. A plain pool exits after the last query, and an idle connection stays open while the process is alive. The same unref applies to the TLS stream `pg` uses after the handshake. This tree has no TLS server, so that path is unread. `pg` cannot describe a statement without running it. That conformance case is skipped.

Bun.sql keeps `idleTimeout` at 0, which is Bun's default (no idle timer). A finished Bun script exits without `close()`. `Query.cancel()` does not abort the backend statement on Bun 1.4, and Bun.sql does not surface `RAISE NOTICE`. Those conformance cases are skipped. Bun.sql also cannot describe a statement without running it. `okmodel/pg/bun` loads only on Bun.

## What works

`.hidden()` stays out of default selects and includes. `.sensitive()` redacts values in logs, errors, and `inspect()`. `one()`, `many()` and `manyThrough()` work; a relation value that is not one of those throws OKM1061.
