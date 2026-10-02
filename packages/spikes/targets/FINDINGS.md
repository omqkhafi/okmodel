# Targets spike findings

Question: can a target stay a logical name through plans and run state, can one runner apply that plan across schemas and databases, and does provisioning from the head snapshot match a target that replayed history?

Engine: Postgres 17 from `bun run db:up` (`postgres://okm:okm@127.0.0.1:55432/okm`). The code lives in the private package `@okmodel/spikes`. Nothing here is published. Invariant I (`batch.atomic`) is the P06 driver spike. This spike covers G, H, and J.

Numbers are one run on this machine. The catalogs are one `items` table and, where noted, a `roles` table. They are not a production schema.

## What worked

- A target is a name, a class (`shared` or `tenant`), a protection flag, and a namespace. The registry resolves it to a URL at execution time. `plan.no-connection` walks the plan and the run state and finds no URL, password, host, or port. Rotating a registry password changes the next resolve and leaves the plan JSON unchanged. An auth failure (`28P01`) rebuilds the pool once.
- Schema-per-tenant resolves every tenant to the shared database and a `tenant_<id>` schema. Database-per-tenant `create(id)` runs `CREATE DATABASE` and resolves that database. Tenant ids are a slug or a UUID. Anything else is OKM1120.
- A pool keyed by the resolved URL, capped at 8, with an idle sweep, held 200 database-per-tenant targets at 8 open pools and 8 backends. Reserved connections were not evicted. After the idle timeout the backends went to 0.
- The runner applied one catalog to 3 schemas and 3 databases. Expand runs shared, then tenants. Contract runs tenants, then shared. `--canary 1` stops after the first tenant. `--class` limits the set. `--max-failures 3` left the rest pending and exited non-zero. A tenant created after the run's first snapshot is picked up on a second pass. A protected tenant whose contract step is blocked (OKM1850) does not fail the other tenants, and the shared contract waits.
- A failed transactional step rolls back. Resume repeats nothing that was checkpointed. A failed `CREATE UNIQUE INDEX CONCURRENTLY` leaves an invalid index; resume drops it and rebuilds it. Run state is rows in the control database, with no connection columns. A second runner on the same target gets OKM1522 immediately from `pg_try_advisory_lock`.
- Killing the runner after the first migration's checkpoint, then resuming, continued from that checkpoint. Resume cost was 31.1 ms.
- An empty schema and an empty database provisioned from `renderCatalog` of head, plus `reference` rows, introspected equal to a schema and a database that had replayed v1 and then the v1→v2 plan (`provision.equivalence`). History on the provisioned side is `provisioned@m2` only. A schema that already has a table and no `okm_meta` is OKM1851.
- Preview is that provision on a new database. A clone rehearsal copies a populated database with `CREATE DATABASE ... TEMPLATE`, refuses a `NOT NULL` column add that existing rows cannot satisfy, then applies a nullable add. The inserted row is still there. The step reports `AccessExclusiveLock`.
- `reference` rows are insert-if-missing by key. A second apply does not update a changed label, does not delete a row the declaration dropped, and does insert a new key. The generated SQL has no `UPDATE` and no `DELETE`.
- `protected.policy` walks every operation class. Read-only work, `expand`, and `reference` are allowed on a protected target. `provision` is allowed only when the target is empty. `contract`, `unclassified`, `push`, `backfill`, `seed`, and `history-repair` are blocked (OKM1850) unless that invocation passes `--allow-protected`. `drop` and `rollback` are blocked on every target, including with `--allow-protected`. There is no down migration, and the engine does not drop a database. Test cleanup drops databases; that is not an operation the policy offers.

## Measurements

Postgres 17, one primary, this machine.

| Measurement                                       | Result                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool, 200 databases, cap 8                        | max open pools 8, max backends 8, 202 evictions, heap +16.6 MB, RSS +46.4 MB, idle sweep closed 8. Wall 20.5 s, including `CREATE DATABASE` for all 200 |
| Resume after SIGKILL                              | 31.1 ms from the control-database checkpoint                                                                                                            |
| Schema runner, 3 targets, concurrency 1 / 2 / 8   | 34.2 / 24.5 / 15.9 ms (88 / 123 / 189 per second)                                                                                                       |
| Schema runner, 20 targets, concurrency 1 / 2 / 8  | 204.4 / 118.6 / 72.3 ms (98 / 169 / 277 per second)                                                                                                     |
| Schema runner, 200 targets, concurrency 1 / 2 / 8 | 2282 / 1258 / 769 ms (88 / 159 / 260 per second)                                                                                                        |
| Database runner, apply only, concurrency 8        | 3 targets 43.4 ms (69/s); 20 targets 115.3 ms (173/s). `CREATE DATABASE` is not in these times                                                          |
| Provision one schema from the snapshot            | 8.3 ms                                                                                                                                                  |
| Provision one database                            | `CREATE DATABASE` 22.7 ms, snapshot install 8.6 ms                                                                                                      |
| Preview database                                  | create 23.3 ms, snapshot install 7.2 ms                                                                                                                 |
| Rehearsal clone of the populated database         | 16.7 ms. The pending nullable add took 0.7 ms and took `AccessExclusiveLock`                                                                            |

Concurrency 8 on 200 schemas is about 3 times concurrency 1, not 8 times. The statements are tiny and they share one primary.

## What the spec cannot keep as written

Confirmed from section 19.7, section 19.8, and the registry. The spec was not edited.

Section 19.7 says the registry may mark individual tenants `protected`. Section 19.8 compares resolved hosts and database names, not schemas, and fails when an unprotected target points at the same database as a protected one (OKM1852). Section 19.5 says schema-per-tenant tenants share one catalog.

The registry resolves every schema-per-tenant tenant to that one database. `tenant:open` and `tenant:keep` differ only by schema (`tenant_open`, `tenant_keep`). Host, port, and database match, and they match the shared target. The guard throws OKM1852 when one of those is protected and another is not. Protecting one tenant while `shared` stays unprotected throws for the same reason.

What still holds: if every target on that database is protected, OKM1852 does not fire. The guard only fails an unprotected target. Database-per-tenant gives each tenant its own database, so one protected tenant does not alias an unprotected one. Test: `schema-per-tenant mixed protection is one database`.

The sentence that cannot be kept is mixed protection on a schema-per-tenant database. Protecting that whole database can be kept. Per-tenant protection under database-per-tenant can be kept.

The prompt also said two logical targets on one physical database must be refused. Section 19.8 only covers the unprotected/protected pair. Two unprotected targets may share a database. The code follows the spec.

## Classification

| Item                                      | Class              | Evidence                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected tenant on a shared database     | contradiction      | Confirmed, spec not edited. Schema-per-tenant tenants and the shared target resolve to one host, port, and database. OKM1852 fires if any of them is unprotected while another is protected. It does not fire when every target on that database is protected. Database-per-tenant databases differ, so one protected tenant is not an alias. |
| Any two targets on one database           | contradiction      | The prompt refuses every alias. Section 19.8 refuses only an unprotected target on a protected database. Two unprotected targets on one database pass.                                                                                                                                                                                        |
| `NOT NULL` column with no default         | missing capability | `items.note` is `text not null` with no default. Provisioning an empty target installs it. The same plan on a populated clone fails: `column "note" of relation "items" contains null values`. The planner emits one `ALTER`. It does not add the column nullable, backfill, then set `NOT NULL`.                                             |
| Canary and the shared contract            | DX                 | `--canary 1` treats only that tenant as in scope, so the shared contract runs after it. Section 19.5 says "every tenant in scope". The other reading, the whole registry, is not what the flag does.                                                                                                                                          |
| `--class shared` and a contract           | DX                 | No tenant is in scope, so the shared contract is not held back.                                                                                                                                                                                                                                                                               |
| `protected` as a status                   | DX                 | Section 19.5 lists `protected` among progress states. The spike keeps it as a flag beside `current`, `behind by expand`, `behind by contract`, `ahead`, and `failed at step`. A protected target can also be behind.                                                                                                                          |
| Failed step inside a unit                 | DX                 | A failed transaction reports the first pending step of that migration, not a later statement in the same unit.                                                                                                                                                                                                                                |
| `lock_timeout` retry                      | missing capability | Section 19.2 describes retry and backoff. This runner does not.                                                                                                                                                                                                                                                                               |
| Concurrent index in the planner           | missing capability | P07 does not emit `CREATE INDEX CONCURRENTLY`. The runner accepts an explicit non-transactional step, and resume drops an invalid index before rebuilding it.                                                                                                                                                                                 |
| Throughput vs concurrency                 | performance        | 200 schema targets: 88/s at concurrency 1, 260/s at concurrency 8, on one primary.                                                                                                                                                                                                                                                            |
| Socket error after `pg_terminate_backend` | bug                | Terminating the reserved postgres.js connection raises `TypeError: null is not an object (evaluating 'socket.write')` from a later write. Resume was tested by SIGKILL of a child process instead. The checkpoint and the resume are unaffected.                                                                                              |

## Decisions

- The per-target lock refuses at once (OKM1522). It does not wait.
- Several named targets and no `--target` is OKM1853, unless the command is a tenant rollout (`--class tenant` or a tenant registry with no named map). Tenant rollout defaults to every tenant.
- `drop` and `rollback` are refused on protected and unprotected targets. `--allow-protected` does not lift them.
- `reference` stays insert-if-missing. "Kept in sync" is not an update.
- The alias key is host, port, and database. Two ports are two servers.
- Pools are keyed by URL. Schema-per-tenant tenants share a pool. The 200-tenant cap was measured with 200 databases.
- Credential rotation uses a new connection. `ALTER ROLE` does not drop an existing session, so the test closes the idle pool before the next query.
- Run state is a schema on the primary database. That database is the control database. It is not a second server.
- Direct apply uses one reserved connection so the advisory lock is session-scoped. It does not go through the capped runtime pool.
- Plans store `"__schema__"` and the runner binds the concrete schema at execution.
