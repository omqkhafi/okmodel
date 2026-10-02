# M0 findings

Consolidated evidence for the M0 gate. Sources are the eight `FINDINGS.md` files under `packages/spikes` and [driver compatibility](../packages/spikes/drivers/COMPATIBILITY.md). Spike code is unchanged. Nothing here is a budget, a spec edit, or a choice among the options in the decision sections.

The class on two topology rows was longer than the five class names. `bug if used as the watermark` is recorded as `bug`, and the statement keeps the condition. `missing capability is still real` is recorded as `missing capability`. Every other class is the spike's own label. Rows are not merged across spikes.

`decision` means the gate has to choose. It is not a recommendation. An implementation task names the prompt that would carry the work if the spec stays as written.

## Counts

68 findings.

| Class | Count |
| --- | ---: |
| contradiction | 10 |
| bug | 8 |
| DX | 20 |
| performance | 7 |
| missing capability | 23 |

| Spike | Findings |
| --- | ---: |
| catalog (P03) | 7 |
| types (P04) | 6 |
| safety (P05) | 9 |
| drivers (P06) | 11 |
| migrations (P07) | 6 |
| infra (P08) | 11 |
| topology (P08A) | 7 |
| targets (P08B) | 11 |

## Findings

| Id | Spike | Class | Statement | Evidence | Spec | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| M0-01 | catalog (P03) | contradiction | Drift hash and source SQL agree only if the hashed definition is the normalised structure. | `packages/spikes/catalog/FINDINGS.md` | §5.7, §19.3 | decision |
| M0-02 | catalog (P03) | missing capability | PGlite `pg_constraint` has no `connullsnotdistinct` column, so reading it aborts introspection. | PGlite `server_version` 18.3; `pg_get_constraintdef` still prints `UNIQUE NULLS NOT DISTINCT` | none | implementation task P13 |
| M0-03 | catalog (P03) | missing capability | `CREATE EXTENSION citext` fails on PGlite and succeeds on Postgres 17. | `extension "citext" is not available` | §4.1 | accepted |
| M0-04 | catalog (P03) | missing capability | An extension is database-scoped, so a schema-scoped scratch target cannot hold it. | Postgres test creates and drops a database | §4.1 | implementation task P40 |
| M0-05 | catalog (P03) | missing capability | A plpgsql body that mentions a table has no `pg_depend` edge; `BEGIN ATOMIC` SQL does. | `touch()` count 0; `task_count()` count greater than 0 | §5.7 | accepted |
| M0-06 | catalog (P03) | DX | Copied partition primary keys and inherited indexes show up as extra objects unless introspection drops them. | Round trip reported `events_low_pkey` and index rows in `pg_inherits` | §5.1 | implementation task P10 |
| M0-07 | catalog (P03) | DX | Integer partition bounds come back quoted. | Database text `FOR VALUES FROM ('0') TO ('100')` for authored `0:100` | §19.3 | implementation task P16 |
| M0-08 | types (P04) | DX | Inferred errors print `ColumnBuilder` and the flag object, not the row. | `packages/spikes/types/snapshots/unknown-table.txt` | §6.8 | decision |
| M0-09 | types (P04) | DX | Declaration emit does not expand `~row`. | `packages/spikes/types/snapshots/declaration.txt` | §6.8 | decision |
| M0-10 | types (P04) | missing capability | Duplicate table names typecheck and become a union of the two row types. | `packages/spikes/types/snapshots/duplicate-name.txt`; OKM1023 | §6.3 | implementation task P12 |
| M0-11 | types (P04) | performance | Recursive duplicate detection does not scale onto `schema()`. | 500 names: 262,107 instantiations; 500-table inferred schema: 126,532 | §6.3 | implementation task P12 |
| M0-12 | types (P04) | DX | An unknown reference is a giant assignability error. The missing name is buried under the builder. | `packages/spikes/types/snapshots/missing-ref.txt` | §6.3 | decision |
| M0-13 | types (P04) | performance | Branded ids add type weight. | Inferred 200-table: 53,410 instantiations branded, 43,676 unbranded | §6.8 | accepted |
| M0-14 | safety (P05) | contradiction | A plain value means equality, and a plain object is OKM1121, so a jsonb column has no equality form. | Spec §10.1; the operator list has no `eq()` helper | §10.1 | decision |
| M0-15 | safety (P05) | DX | `where` does not say whether it appends or replaces, so a preset function can erase a caller filter. | A find with only `pending()` verifies; the caller filter was never recorded | §10.1 | decision |
| M0-16 | safety (P05) | DX | OKM1190 names one rule when several rules fail. | The spike returns every violation, sorted; `rule` is the first of that list | §5.2 | decision |
| M0-17 | safety (P05) | missing capability | Structural identifier rejection has no OKM code of its own. | Length, NUL, controls, and unquoted reserved words use OKM1120 with rule `identifier` | §10.1 | decision |
| M0-18 | safety (P05) | missing capability | A hidden allowlist has no OKM code. | The spike uses OKM1190 `hidden` | §10.2 | decision |
| M0-19 | safety (P05) | performance | Tagged operators are a fixed type cost. | +639 instantiations and +549 types at 200 tables; the same 663 instantiations at 10 and 50 | §10.1 | accepted |
| M0-20 | safety (P05) | performance | Verification is linear in predicates and tables. | 1 predicate mean 4.6 µs; 128 predicates mean 232 µs; 40 tables mean 220 µs | §5.2 | accepted |
| M0-21 | safety (P05) | missing capability | The checker is structural, not a SQL prover. | `NOT (tenant_id <> $tenant)` is not representable; unverifiable SQL is the `trusted` hatch | §16 | accepted |
| M0-22 | safety (P05) | missing capability | Cascade, to-many bounds, and capabilities are not checked. | The spike checks tenant, archive mode, guarded input, hidden projection, redaction, read bounds, write filters, and parameters | §5.2 | implementation task P21 |
| M0-23 | drivers (P06) | missing capability | PGlite cannot cancel an in-flight statement and does not enforce `statement_timeout`. | `pg_sleep(0.35)` took 352 ms after `statement_timeout` 40 ms; `cancel` is not declared | §4, §15 | accepted |
| M0-24 | drivers (P06) | DX | postgres.js `unsafe` ignores the connection `prepare` flag unless the call repeats it. | Named prepares were invisible until `{ prepare: true, simple: false }` | §4.2 | implementation task P13 |
| M0-25 | drivers (P06) | DX | postgres.js rewrites wire-text parameters in its serializers. | Boolean `"t"` was stored as false until serialize was overridden | §4.2 | implementation task P13 |
| M0-26 | drivers (P06) | DX | Unnamed extended statements do not appear in `pg_prepared_statements`. | The trigger saw `<none>` and `current_query()` containing `$1` | §4 | accepted |
| M0-27 | drivers (P06) | bug | postgres.js throws off-promise if a write is queued after `pg_terminate_backend`. | `socket.write` of null in `connection.js` `nextWrite` | §15 | implementation task P13 |
| M0-28 | drivers (P06) | contradiction | Kind for a timeout is `timeout` in the error table and `cancelled` for a batch. | This spike uses `timeout` for `execute` and `cancelled` for `batch` | §14, §15 | decision |
| M0-29 | drivers (P06) | contradiction | A deferred constraint failure is `COMMIT`, so `batchIndex` is null. | SQLSTATE 23505 at commit; the suite records null | §15 | decision |
| M0-30 | drivers (P06) | bug | Neither adapter clears session state when a connection is released. | `okm.p06=yes` was still visible on the next checkout | §15.2 | implementation task P13 |
| M0-31 | drivers (P06) | missing capability | postgres.js has no `stats()`. | Adapter counters; `size` stays at the configured max after a backend is killed | §4.2 | implementation task P13 |
| M0-32 | drivers (P06) | missing capability | The batch-mode harness is `BEGIN`/`COMMIT`, not a native atomic batch, and it can cancel. | It does not model an HTTP request already sent | §15 | no action |
| M0-33 | drivers (P06) | performance | Atomic batch sends N+2 statements and does not pipeline. | 8 statements plus `BEGIN` and `COMMIT`: mean 1.794 ms on postgres.js; raw pipeline of 8 `SELECT 1` was 0.607 ms | §15 | accepted |
| M0-34 | migrations (P07) | contradiction | The structural hash is unchanged when only a view's SQL changes. Confirms M0-01. | Sections 5.7 and 19.3; the spec was not edited | §5.7, §19.3 | decision |
| M0-35 | migrations (P07) | missing capability | A plpgsql function with no declared edge survives `DROP TABLE` and then fails when called. | `task_rows` reads `tasks`; `pg_depend` has no edge | §5.7 | accepted |
| M0-36 | migrations (P07) | bug | The ambiguous-rename scan was quadratic. Fixed in the spike. | 200-table diff was 819 ms, then 5.96 ms | §19.1 | no action |
| M0-37 | migrations (P07) | DX | Quoted integer partition bounds are unchanged from P03. List, hash, and timestamptz bounds need their own spellings. | Normalised forms `0:100`, `list:1,2`, `hash:2:0` | §19.3 | implementation task P16 |
| M0-38 | migrations (P07) | DX | `LANGUAGE sql` takes `AccessShareLock` on the tables it reads. plpgsql takes none. | Lock table in `packages/spikes/migrations/FINDINGS.md` | §19.1 | implementation task P51 |
| M0-39 | migrations (P07) | bug | Recreating a table dropped `touch()` while its trigger still called it. Fixed in the spike. | Seed 8: `cannot drop function touch() because other objects depend on it` | §5.7 | no action |
| M0-40 | infra (P08) | contradiction | The version path is checked at apply, not while planning, and the planner never raises OKM1814. | Postgres 17 accepts `1.4` to `1.6` and rejects `1.6` to `999` with `22023`; paths downward from `1.6` are empty | §4.1 | decision |
| M0-41 | infra (P08) | contradiction | Extension members are omitted, not recorded as `external`. | 47 `citext` functions filtered by `pg_depend` deptype `e`; 2 types and 26 operators are not catalog kinds | §4.1 | decision |
| M0-42 | infra (P08) | missing capability | `DROP ROLE` is cluster-wide and the before catalog of one database cannot see the other database's grant. | `2BP01`: `1 object in database d_…` | §5.7 | decision |
| M0-43 | infra (P08) | missing capability | `CREATE ROLE` has no `IF NOT EXISTS`. A managed role that already exists fails unless the before catalog marks it `external`. | SQLSTATE `42710` | §5.7 | implementation task P43 |
| M0-44 | infra (P08) | missing capability | The plan cannot see `CREATEROLE`. `NOSUPERUSER NOCREATEROLE` fails at apply. | `42501` versus success with `CREATEROLE` | §5.7 | implementation task P43 |
| M0-45 | infra (P08) | missing capability | Default privileges follow the creating role, and the plan emits no `SET ROLE`. | A table created by the session user did not receive the default; a table created after `SET ROLE mig` did | §5.7 | decision |
| M0-46 | infra (P08) | missing capability | The archive parent rule is not enforced. A child can clear `archived_at` while its parent stays archived. | The foreign key stayed valid | §8 | implementation task P25 |
| M0-47 | infra (P08) | missing capability | The plan can emit `SET SCHEMA` for an extension that is not relocatable. | `plpgsql` fails with `0A000` | §4.1 | implementation task P40 |
| M0-48 | infra (P08) | DX | Grant identity `(role, object, privilege)` is longer than 63 bytes and is not a stored name. | `assertCatalog` does not apply the identifier limit to grants or default privileges | §5.7 | decision |
| M0-49 | infra (P08) | DX | A full unique constraint sees archived duplicates. The partial unique does not. | `UNIQUE (sku)` failed with `23505` because two archived rows shared `sku` | §8 | implementation task P25 |
| M0-50 | infra (P08) | DX | The lock helper's fallback would call `GRANT` an `AccessExclusiveLock`. | `pg_locks` showed `AccessShareLock` on `pg_class` and no lock on the table | §19.1 | implementation task P51 |
| M0-51 | topology (P08A) | contradiction | The in-transaction insert LSN is the start of the commit record. §15.1 says that reading is below the commit record. | Delta 0 on every sample; the record is 34 bytes and starts at that LSN | §15.1 | decision |
| M0-52 | topology (P08A) | bug | `pg_current_wal_lsn()` under `synchronous_commit` off sits before the commit record if it is used as the watermark. | 7 of 7 sync-off samples; the insert LSN was past the record on the same round trip | §15.1 | accepted |
| M0-53 | topology (P08A) | bug | The postgres.js adapter holds one mutex for the whole pool, so a second checkout waits until the first connection is released. | A second primary connection failed as OKM1846 after 2000 ms | §15.2 | implementation task P13 |
| M0-54 | topology (P08A) | bug | `connection.batch()` inside an open SQL transaction commits the outer transaction. | The spike runs batches inside `tx()` as savepoints; the adapter batch is `BEGIN`/`COMMIT` | §15 | implementation task P29 |
| M0-55 | topology (P08A) | performance | The position read is a second round trip after `COMMIT`, not pipelined with it. | One `pg_current_wal_insert_lsn` per committed write | §15.1 | implementation task P63 |
| M0-56 | topology (P08A) | DX | The spike prompt names `random` and `least-loaded`. §15.1 names `leastConnections` and `latencyAware`. | `least-loaded` is `leastConnections`; `random` is implemented as well | §15.1 | no action |
| M0-57 | topology (P08A) | missing capability | `PUBLIC` can execute the position functions on this image. The capability is still missing when `EXECUTE` is revoked. | `has_function_privilege` is true for `PUBLIC`; a non-superuser replica login fails the probe after revoke | §15.1 | accepted |
| M0-58 | targets (P08B) | contradiction | A protected tenant and an unprotected target on a schema-per-tenant database are the same host, port, and database, so OKM1852 fires. | Test `schema-per-tenant mixed protection is one database` | §19.5, §19.7, §19.8 | decision |
| M0-59 | targets (P08B) | contradiction | §19.8 refuses an unprotected target on a protected database. It does not refuse two unprotected targets on one database. | The code follows the spec; the spike prompt asked to refuse every alias | §19.8 | decision |
| M0-60 | targets (P08B) | missing capability | A `NOT NULL` column with no default installs on an empty target and fails on a populated clone. | `column "note" of relation "items" contains null values` | §19.1 | implementation task P50 |
| M0-61 | targets (P08B) | DX | `--canary 1` treats only that tenant as in scope, so the shared contract runs after it. | §19.5 says every tenant in scope | §19.5 | decision |
| M0-62 | targets (P08B) | DX | `--class shared` puts no tenant in scope, so the shared contract is not held back. | Rollout test in `packages/spikes/targets/FINDINGS.md` | §19.5 | decision |
| M0-63 | targets (P08B) | DX | `protected` is a flag beside the progress states, not a progress state of its own. A protected target can also be behind. | §19.4 lists `protected` among status states | §19.4, §19.5 | decision |
| M0-64 | targets (P08B) | DX | A failed transaction reports the first pending step of that migration, not a later statement in the same unit. | Resume tests in `packages/spikes/targets/FINDINGS.md` | §19.2 | implementation task P16 |
| M0-65 | targets (P08B) | missing capability | The runner does not retry `lock_timeout`. | §19.2 describes retry and backoff | §19.2 | implementation task P16 |
| M0-66 | targets (P08B) | missing capability | The planner does not emit `CREATE INDEX CONCURRENTLY`. The runner can resume an explicit non-transactional step. | P07 does not emit the statement; resume drops an invalid index | §19.2 | implementation task P50 |
| M0-67 | targets (P08B) | performance | Throughput does not scale with concurrency on one primary. | 200 schema targets: 88/s at concurrency 1, 260/s at concurrency 8 | §19.5 | accepted |
| M0-68 | targets (P08B) | bug | Terminating the reserved postgres.js connection raises `socket.write` of null on a later write. | Resume was tested by SIGKILL of a child process instead | §15 | implementation task P13 |

## Contradictions

Each item quotes the spec sentence the spike measured against. M0-01 and M0-34 are the same pair of sentences, kept as two rows.

### M0-01 and M0-34 — drift hash versus source SQL

§5.7:

> Every node carries: owner (`managed` / `external` / `ignored`), a canonical definition (its hash drives diff and drift), dependency edges at object or **column** granularity, and provenance (which trait, extension or file contributed it).

§19.3:

> Expressions that the database rewrites (defaults, checks, generated columns, view and function bodies) are not compared as text: the declared definition is applied to a scratch database and read back, and both sides go through the database before comparing.

View and function bodies are rewritten. Equality in both spikes uses the normalised structure and a scratch reprint, not the source text. Those two sentences fit together only if the hashed definition is that normalised structure.

### M0-14 — plain equality and plain objects

§10.1:

> A plain value means equality; `null` means `IS NULL`.

§10.1:

> A plain object where a value is expected is rejected at runtime (OKM1121).

jsonb equality is an object. The spike rejects every bare object, and the operator list has no `eq()` helper, so an object column has no equality form.

### M0-16 is not in this list

M0-16 is classed DX. The sentence it presses on is in §5.2: "A violation throws OKM1190 naming the rule and the contribution that caused it." The decision section quotes it. It is not classed contradiction.

### M0-28 — `timeout` and `cancelled`

§14, the `transient` row, lists `timeout` and does not list `cancelled`:

> serialization, deadlock, lock_timeout, timeout, unavailable

§15:

> an aborted call cancels the statement where the driver has `cancel`, and fails as kind `cancelled` (category `transient`, never retried).

§15, batch contract:

> Where the driver can cancel, the batch rolls back (kind `cancelled`).

The spike uses `timeout` for `execute` and `cancelled` for `batch`.

### M0-29 — `batchIndex` at commit

§15:

> A failing statement rolls the whole batch back; the error is the mapped database error and carries `batchIndex`.

A deferred unique failure is `COMMIT` (SQLSTATE 23505), which is not one of the caller's statements. The suite records `batchIndex` null.

### M0-40 — extension version path

§4.1, the lifecycle table:

> raise `version` — `ALTER EXTENSION ... UPDATE TO ...`, with the path checked in `pg_extension_update_paths` at planning time

> lower `version` — not supported by Postgres — refused (OKM1814)

The planner emits `UPDATE TO` with no server attached. Postgres 17 accepts `1.4` → `1.6` and rejects `1.6` → `999` with `22023`. Every path from installed `1.6` back to `1.4`, `1.5`, `1.3`, `1.2`, `1.1`, or `1.0` is empty. The planner never raises OKM1814.

### M0-41 — extension members

§4.1:

> Objects created by an extension are recorded as `external` and never diffed.

Functions are dropped by a `pg_depend` filter (47 `citext` functions, 0 leaked). Types (2) and operators (26) are not catalog kinds, so they are invisible. Nothing stores them as `external`.

### M0-45 — default privileges

Classed missing capability. The sentence it does not satisfy is §5.7:

> With `roles: { migration, app }` the catalog emits `GRANT` and `ALTER DEFAULT PRIVILEGES` for the application role on every managed object, so a new table is reachable without manual steps; fine-grained grants come in M2.

A table created by the session user did not receive the default. A table created after `SET ROLE mig` did. The plan emits no `SET ROLE`.

### M0-51 — commit record and the in-transaction LSN

§15.1:

> Reading it inside the transaction would be wrong (below the commit record).

On this server the in-transaction `pg_current_wal_insert_lsn()` is the start of the commit record (delta 0). The record is 34 bytes. A replay position at that LSN has not applied the commit. The after-commit insert LSN is 40 bytes past the start.

### M0-58 — protected tenant on a shared database

§19.7:

> Protection never affects the application's runtime `connect()`, and it is a property of the Target: the registry may mark individual tenants `protected`.

§19.8:

> `okm check` and `okm doctor` compare the resolved hosts and database names of all targets and fail when an unprotected target points at the same database as a protected one (OKM1852).

§19.5, the `--concurrency` row:

> the default is 2 for `schemaPerTenant` (tenants share one catalog and its locks)

Schema-per-tenant tenants and the shared target resolve to one host, port, and database. OKM1852 fires when one of them is protected and another is not. It does not fire when every target on that database is protected. Database-per-tenant databases differ, so one protected tenant is not an alias.

### M0-59 — two targets on one database

The same §19.8 sentence refuses only an unprotected target on a protected database. Two unprotected targets on one database pass. The spike prompt said two logical targets on one physical database must be refused. The code follows the spec.

## Cross-spike measurements

Spike files say "this machine" and do not record a hostname. Versions below are the ones each file names. The cold-start measurement later in this file records the gate host.

TypeScript for P04 and P05 is 7.0.2. postgres.js is 3.4.9. The PGlite package is 0.5.8. PGlite reports `server_version` 18.3. Docker Postgres for the driver conformance run is 17.11 (Debian 17.11-1.pgdg13+2). Other spikes say Postgres 17 from `bun run db:up`.

| Spike | Measurement | Result | Versions |
| --- | --- | --- | --- |
| catalog | Hash, 200 tables, 1558 objects | 4.45 ms once, 4.49 ms mean | Postgres 17; PGlite 18.3 |
| catalog | Apply 200 tables | PGlite 135.45 ms; Postgres 17 209.79 ms | same |
| catalog | Introspect 200 tables | PGlite 14.33 ms; Postgres 17 9.75 ms | same |
| types | Inferred 200 | 53,410 instantiations, 8,390 types, 0.023 s, 36,205 K | TypeScript 7.0.2 |
| types | Emitted 200 | 0 instantiations, 559 types, 0.001 s, 27,900 K | TypeScript 7.0.2 |
| types | Inferred 500 | 126,532 instantiations, 17,654 types, 0.083 s | TypeScript 7.0.2 |
| types | Emitted 500 | 0 instantiations, 859 types, 0.001 s | TypeScript 7.0.2 |
| types | Inferred 200, ids not branded | 43,676 instantiations, 7,172 types | TypeScript 7.0.2 |
| types | Inferred 200, 10 extension columns | 63,621 instantiations, 8,843 types | TypeScript 7.0.2 |
| types | `DuplicateNames`, 500 names | 262,107 instantiations | TypeScript 7.0.2 |
| safety | Tagged minus equality, 200 tables | +639 instantiations, +549 types | TypeScript 7.0.2 |
| safety | Tagged instantiations at 10, 50, and 200 | 663 | TypeScript 7.0.2 |
| safety | Inferred tagged minus inferred equality, 200 | +641 instantiations, +490 types | TypeScript 7.0.2 |
| safety | Verify, 1 / 128 predicates | mean 4.640 µs / 231.722 µs | one run, host not recorded |
| safety | Verify, 1 / 40 tables | mean 3.970 µs / 219.518 µs | one run, host not recorded |
| drivers | `execute` cancel of `pg_sleep(8)` | postgres.js 33–36 ms; PGlite not declared | Postgres 17.11; PGlite 18.3 |
| drivers | `batch` of 8 `SELECT 1` | postgres.js mean 1.794 ms; PGlite mean 1.319 ms | same |
| drivers | Raw pipeline of 8 `SELECT 1` | postgres.js mean 0.607 ms | same |
| drivers | `SELECT 1` overhead | postgres.js adapter 175 µs; PGlite adapter 62 µs | same |
| migrations | Diff / plan, 200 tables | 5.96 ms / 20.96 ms | Postgres 17 |
| migrations | Scratch apply / introspect, 200 tables | 201.93 ms / 9.37 ms | Postgres 17 |
| migrations | Property cases in `bun run check` | 100 cases, 0 failures, 2964 ms | Postgres 17 |
| migrations | `OKM_MIGRATION_CASES=500` | 500 cases, 0 failures, 13967 ms | Postgres 17 |
| infra | Diff, 1000 grants, one grant added | 4.69 ms | Postgres 17 |
| infra | Apply, 50 roles and 1000 grants | 324.15 ms | Postgres 17 |
| infra | `int8` to `int4`, 100k rows, half archived | 88.48 ms | Postgres 17 |
| infra | Add unique, 100k rows | 107.65 ms | Postgres 17 |
| infra | `pg_available_extensions` query | 15: 33.12 ms, 47 extensions; 16: 24.93 ms, 47; 17: 14.75 ms, 45; 18: 20.10 ms, 46 | Postgres 15–18 images |
| infra | `citext` default version | 1.6 on 15–17; 1.8 on 18 | same |
| topology | Routing decision, 5000 calls | mean 0.367 µs, p99 1.208 µs | Postgres 17 |
| topology | Commit record vs after-commit insert LSN | record 34 bytes; insert LSN 40 bytes past the start | Postgres 17 |
| topology | Read-your-writes violations | 0 | Postgres 17 |
| topology | Extra statements per committed write | 1 `pg_current_wal_insert_lsn`; 0 when eventual or no replicas | Postgres 17 |
| topology | First read after a write / next read | 0.648 ms / 0.164 ms | Postgres 17 |
| targets | Pool, 200 databases, cap 8 | max 8 pools, max 8 backends, RSS +46.4 MB | Postgres 17 |
| targets | Resume after SIGKILL | 31.1 ms | Postgres 17 |
| targets | Schema runner, 200 targets, concurrency 1 / 8 | 2282 ms (88/s) / 769 ms (260/s) | Postgres 17 |
| targets | Provision one schema / one database snapshot | 8.3 ms / 8.6 ms | Postgres 17 |

Full tables remain in each spike's `FINDINGS.md`. Compatibility passes and skips are generated in `packages/spikes/drivers/COMPATIBILITY.md`. PGlite skips cancel, stream, and named prepare. The batch-mode row skips interactive transactions, stream, listen, describe, and named or unnamed prepare. Atomic batch success, failure, deferred constraints, and sequences pass on all three.

## Decision inputs

Options are listed. None is selected.

### Catalog contract

What has to be settled before the contract is frozen.

Evidence: M0-01, M0-04, M0-05, M0-06, M0-34, M0-35, M0-40, M0-41, M0-42, M0-43, M0-44, M0-45, M0-47, M0-48. The envelope (`kind`, `identity`, `owner`, `definition`, `dependencies`, `provenance`) held every kind the catalog spike tried, including role, grant, and default privilege in the infra spike. Identity stayed kind-specific.

**Identity per kind.** §5.7 already lists different keys: `(namespace, name)`, `(parent, name)`, `(schema, name, argTypes[])`, `(table, name)`, `(role, object, privilege)`, and extension `name`. The catalog spike confirms that an extension has no namespace and a function's identity includes argument types.

Options:

- Freeze §5.7's per-kind keys.
- Flatten identity into one struct.

**Dependency declarations.** `pg_depend` does not reconstruct a plpgsql body. `BEGIN ATOMIC` SQL can be inferred. §5.7 already requires `dependsOn` for plpgsql (OKM1824). Copied partition keys and inherited indexes are not authored.

Options:

- Keep declared `dependsOn` for plpgsql, infer `BEGIN ATOMIC`, and drop copied partition objects on introspection.
- Require the author to declare the copied partition objects.

**Hash form.** M0-01 and M0-34. Canonical JSON plus SHA-256 was stable across key order, object order, and process runs. The structural hash ignores view SQL. Scratch reprints match two spellings of the same check, view, SQL function, and plpgsql body, and differ when the predicate changes. One SQL function spelling does not match its own source (`count(*)::int8` is stored as `count(*) AS count` returning `bigint`).

Options:

- Hash the normalised structure. Keep authoring SQL, function bodies, and check text as input. Judge view and function bodies by a scratch reprint.
- Hash the authoring text.

**Extension members.** M0-41. §4.1 says extension objects are recorded as `external` and never diffed. The spike filters functions with `pg_depend` deptype `e` and does not store types or operators at all. M0-40: the update path is not checked at plan time. M0-47: `SET SCHEMA` is still emitted when `extrelocatable` is false. `citext` defaults to 1.6 on Postgres 15–17 and 1.8 on 18, with several versions on one image. M0-04: apply is database-scoped.

Options:

- Record extension members as `external`.
- Keep omitting them from the user-object diff, and say so in the spec.
- Check `pg_extension_update_paths` only when a server is attached, or refuse an offline plan that changes a version.

**Roles and grants.** M0-42 through M0-45 and M0-48. Roles are cluster-wide; the catalog is per database. There is no `CREATE ROLE IF NOT EXISTS`. `CREATEROLE` is the gate, not superuser. Default privileges follow the creating role. Grant identity is not a 63-byte identifier. `aclexplode` also returns the owner's privileges. Role changes that went through the generic drop-and-recreate path would `DROP ROLE`.

Options:

- Keep roles in the per-database catalog and teach the plan about cluster-wide dependencies, `SET ROLE`, and `CREATEROLE`.
- Leave roles out of the frozen catalog until that plan exists.
- Exempt grant identity from the 63-byte fit, or give grants a fitted name plus a separate key.

### Row-type default

Evidence is P04, TypeScript 7.0.2, seed 1, tenancy `none`. Empty project baseline: 340 types, 0 instantiations. §6.8 says row types are either inferred from table files or emitted by `okm dev` into `.okm/types.d.ts`, and that the M0 spike decides (D25). D29 already removed branded ids. The unbranded 200-table row is the weight that decision named.

| Project | Instantiations | Types | Check (s) | Memory (K) |
| --- | ---: | ---: | ---: | ---: |
| inferred 10 | 5,438 | 2,388 | 0.004 | 27,437 |
| emitted 10 | 0 | 369 | 0 | 25,177 |
| inferred 50 | 15,318 | 3,634 | 0.005 | 29,220 |
| emitted 50 | 0 | 409 | 0 | 25,800 |
| inferred 200 | 53,410 | 8,390 | 0.023 | 36,205 |
| emitted 200 | 0 | 559 | 0.001 | 27,900 |
| inferred 500 | 126,532 | 17,654 | 0.083 | 49,950 |
| emitted 500 | 0 | 859 | 0.001 | 32,124 |
| inferred 200, ids not branded | 43,676 | 7,172 | 0.017 | 33,878 |
| emitted 200, ids not branded | 0 | 559 | 0.001 | 28,057 |

Instantiations from 50 to 200 to 500 grow by about 250 per table. Types grow by about 31 per table. Emitted types grow by about 1 per table. The spike's recommendation was to emit. This file does not adopt it.

Hover text was not measured. TypeScript 7.0 has no compiler API (D111). The proxy is `tsc` error text and declaration text.

Options:

- Default to types inferred from `table()` / `schema()`. The 200-table inferred run is 53,410 instantiations and 8,390 types. Error text and declaration emit print the builder.
- Default to interfaces emitted in the style of `.okm/types.d.ts`. Authors keep `table()` / `schema()`. App code reads the interfaces. Checking the schema file still pays the inferred cost when that file is part of the program. Emitted insert errors name `Insert_t000`.
- Emit, and still reject duplicate names (OKM1023) somewhere other than the recursive checker. That checker costs more than inferring the 500-table schema.

### Commit-position mechanism

Evidence is P08A on Postgres 17, primary and two replicas. The watermark the spike used is `pg_current_wal_insert_lsn()` read after commit, on the committing connection. Read-your-writes violations: 0. With both replicas paused, 20 reads returned the new row from the primary. After one replica caught the watermark, 10 reads returned the new row from that replica.

| Shape | In-transaction insert LSN | After-commit insert LSN | `pg_current_wal_lsn()` |
| --- | --- | --- | --- |
| Single insert, sync on | record start | 40 bytes past the start | past the record |
| Three inserts, sync on | record start | 40 bytes past the start | past the record |
| `synchronous_commit` off, 7 samples | record start | 40 bytes past the start, every sample | behind the commit record on all 7 |

The commit record was 34 bytes. The after-commit insert LSN was 6 bytes past the record (MAXALIGN) when nothing else wrote WAL first. A paused replica did not land inside that 40-byte gap (`sawGap: false`). Cost: one extra statement per committed write when replicas are configured and consistency is session; zero for eventual consistency or no replicas. The adapter did not pipeline that statement (M0-55). §15.1 says it is pipelined.

Options:

- Confirm the mechanism: after-commit `pg_current_wal_insert_lsn()` on the committing connection. Do not use the in-transaction insert LSN. Do not use `pg_current_wal_lsn()` when `synchronous_commit` is off.
- Amend the §15.1 phrase "below the commit record". The measured in-transaction reading is the start of the commit record, not a position below it.

### Targets and protection

Evidence is P08B on Postgres 17. A target in the spike is a name, a class (`shared` or `tenant`), a protection flag, and a namespace. Plans and run state had no URL, password, host, or port. Schema-per-tenant resolves every tenant to the shared database. Database-per-tenant gives each tenant its own database.

Partial scope:

- `--canary 1` limits scope to that tenant, then the shared contract runs (M0-61). §19.5 says the shared `contract` step runs only after it succeeded on every tenant in scope.
- `--class shared` puts no tenant in scope, so the shared contract is not held back (M0-62).
- A protected tenant whose contract step is blocked (OKM1850) does not fail the other tenants, and the shared contract waits. That part matched the spike's reading of failure isolation.

Protection per physical database:

- Mixed protection on one schema-per-tenant database throws OKM1852 (M0-58). Protecting every target on that database does not. One protected database-per-tenant database does not alias an unprotected one.
- Two unprotected targets may share a database (M0-59). §19.8 only covers the unprotected/protected pair.
- `protected` is both a flag (§19.7) and a status word in `okm migrate status` (§19.4). The spike keeps the flag beside `current`, `behind by expand`, `behind by contract`, `ahead`, and `failed at step` (M0-63).

Options:

- Per-tenant `protected` only under database-per-tenant. Schema-per-tenant protection applies to the whole database.
- Change the alias key so two schemas on one database are not the same target for OKM1852.
- Keep §19.8 as written (mixed protection only), or refuse every pair of logical targets on one host, port, and database.
- Canary scope is the tenants named by the flag, or the whole registry, when deciding whether the shared contract may run.
- `--class shared` either skips the "every tenant in scope" wait, or refuses a shared contract while tenant targets exist outside the class.
- Status `protected` stays a flag that combines with a progress state, or it remains a single status value as §19.4 lists it.

### Batch, cancellation, and error codes

Evidence is P05 and P06, plus the compatibility table.

Cancellation. postgres.js `cancel()` aborts `pg_sleep` with SQLSTATE 57014. PGlite does not declare `cancel` and does not enforce `statement_timeout` (352 ms for a 350 ms sleep). A pre-aborted `AbortSignal` fails before the statement starts on both, and the insert does not land. The batch-mode harness can cancel because it sits on postgres.js. It does not model "HTTP request already sent → `outcome_unknown`".

Batch. Atomic `batch` matched on commit, rollback, failure index, deferred constraints at commit, sequences, and a savepoint inside `tx()` on an interactive driver. `pg_terminate_backend` mid-batch was `outcome_unknown` on postgres.js, with observed rows 0, and the driver did not claim a rollback. PGlite has no separate backend to kill. Inside `tx()`, the spike used a savepoint; the adapter's own `batch()` is `BEGIN`/`COMMIT` and committed the outer transaction (M0-54).

Kinds and codes the spikes found missing or inconsistent:

| Item | What the spec says | What the spike did |
| --- | --- | --- |
| M0-28 | §14 lists `timeout`. §15 says an aborted call and a cancellable batch fail as `cancelled`. | `timeout` for `execute`, `cancelled` for `batch` |
| M0-29 | §15 says the failing statement's error carries `batchIndex`. | null when the failure is `COMMIT` |
| M0-14 | §10.1: a plain value means equality, and a plain object is OKM1121. | no equality form for jsonb |
| M0-16 | §5.2: OKM1190 names the rule and the contribution. | every violation, sorted; `rule` is the first |
| M0-17 | OKM1120 is "unknown field". | length, NUL, controls, and unquoted reserved words reuse OKM1120 with rule `identifier` |
| M0-18 | §10.2: hidden fields can never be allowlisted. No code is named. | OKM1190 `hidden` |
| M0-15 | Presets are written as `(q) => q.where(...)`. | a function can replace `where` before the caller filter is recorded |

Options:

- Add `cancelled` to the §14 kind list, or stop using it and map those failures to `timeout`.
- Allow `batchIndex` null when the failure is the commit itself, or require a sentinel and say so in §15.
- Define an equality form for object values, or exclude object columns from plain equality.
- OKM1190 carries one rule, or it carries the stable set of violations.
- Give identifier rejection and a hidden allowlist their own codes, or keep the codes the spike used.
- State whether `where` appends or replaces. A preset is a list of predicates, or it remains a function that receives the query.

## Cold start and size

Order-of-magnitude inputs for later budgets. Not budgets.

Command, per entry: `bun build <entry> --target node --minify`. Gzip level 9. Brotli quality 11. Import time is `performance.now` around `import()` in a fresh process, 20 runs, arithmetic mean, nearest-rank p95 (`ceil(0.95 * 20) - 1`). The process start is not included. Warm: one warmup import, then 20 imports of the same file. Cold: each run writes a new file with `fcntl` `F_NOCACHE` (48) before the first read. Reproduce with `bun ./packages/spikes/src/m0/measure.ts`.

Gate host: `Alis-MacBook-Air.local`, Apple M4, 24 GiB, darwin 27.0.0 arm64. Node v26.7.0. Bun 1.4.2. TypeScript 7.0.2. No Postgres was required for this measurement.

Entries under `packages/spikes/src/m0/entries/` import the catalog and the catalog diff, the safety verifier, the routing decision, and the driver registry. The combined entry imports all four.

| Module | Raw | Gzip | Brotli | npm packages in the bundle |
| --- | ---: | ---: | ---: | --- |
| catalog + diff | 9,417 | 3,274 | 2,934 | none |
| safety verifier | 6,749 | 2,402 | 2,129 | none |
| router | 648,971 | 157,129 | 109,481 | `@electric-sql/pglite` 605,930 bytes; `postgres` 38,566 bytes |
| driver registry | 3,187 | 1,082 | 923 | none |
| combined | 668,070 | 163,293 | 114,664 | same two packages |

The byte counts on the npm packages are the bundler's `bytesInOutput`, not a second file. Router output minus those two packages is 4,475 bytes. That is the router sources plus `packages/harness/src/lsn.ts` inside the same minified file.

Import time, milliseconds:

| Module | Node warm mean / p95 | Node cold mean / p95 | Bun warm mean / p95 | Bun cold mean / p95 |
| --- | --- | --- | --- | --- |
| catalog + diff | 1.670 / 1.838 | 2.073 / 3.069 | 4.707 / 4.992 | 4.744 / 5.013 |
| safety verifier | 1.589 / 1.737 | 1.748 / 1.827 | 4.643 / 4.883 | 4.760 / 4.899 |
| router | 12.663 / 13.131 | 13.730 / 14.457 | 16.361 / 16.710 | 16.636 / 17.054 |
| driver registry | 1.862 / 1.984 | 2.054 / 2.314 | 5.820 / 6.164 | 5.782 / 6.002 |
| combined | 17.439 / 29.428 | 16.115 / 17.077 | 17.429 / 18.130 | 17.191 / 17.677 |

Combined Node warm p95 is one of two slow samples (29.428 ms and 30.285 ms) in that series. The other 18 samples were between 13.5 ms and 19.0 ms.

An 8 MiB file written with `F_NOCACHE` then read in a fresh Bun process took 9.450 ms the first time and 6.425 ms the second. Import times for the small bundles moved by tenths of a millisecond between warm and cold. Warm and cold are the same order of magnitude.

Reading the orders of magnitude off the clean modules: a few kilobytes minified, about 1–3 KB gzipped, import about 2 ms on Node and about 5 ms on Bun. The router figure is not that. It is about 0.6 MB and about 15 ms because of the packages below.

### Runtime dependencies

Catalog + diff, the verifier, and the registry import no npm package and no `node:` module. Their bundles contain none.

The router imports `compareLsn` from `@okmodel/harness`. That package's entry also re-exports the Postgres and PGlite openers. `@okmodel/harness` has no `dependencies`. Its `devDependencies` are `postgres` and `@electric-sql/pglite`. The default bundle still contains both, because the barrel is not marked free of side effects. `packages/harness/src/postgres.ts` and `packages/harness/src/pglite.ts` contribute 0 bytes of their own and the libraries they import contribute the sizes above.

`@okmodel/spikes` depends on `@okmodel/harness` and has `postgres`, `@electric-sql/pglite`, and `fast-check` in `devDependencies` only. `fast-check` is not in any measured bundle.

The catalog bundle calls `Bun.CryptoHasher` inside `sha256`. That is a Bun global, not an npm package. Import succeeded on Node. Calling `sha256` on Node would not.

So the check holds for the catalog diff, the verifier, and the registry. It does not hold for the router or the combined bundle, until the router stops importing the harness barrel.
