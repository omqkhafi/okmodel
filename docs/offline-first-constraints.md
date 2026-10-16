# Offline-first constraints

Normative. R1–R7 are architectural constraints (D265). They are not a phase, and they are not permission to build a feature. The sequence stays PostgreSQL, then SQLite, then MySQL, then shared SQL, then OKModel inside OKEngine. Placement is rule 12 under How we work, the 0.8 and 0.9 rows, and the M3 and M4 sentences in [`okmodel-execution-plan.md`](okmodel-execution-plan.md).

## Boundary

OKModel builds no sync cursors, CDC adapters, offline command queues, sync authorization, conflict handling, or realtime orchestration. SQLite support does not commit OKModel to browser or Expo storage adapters.

## R1. Two schema descriptions, one source

The catalog is the physical description for migrations. Client generators sit outside the catalog and outside its hash. `okmodel/internal` has no stability promise ([`api.md`](api.md)).

A future consumer also needs a logical, serializable description derived from the existing schema source: keys, including composite keys, relations, types, codecs, defaults, client-generated id rules, and schema version. There is no second sync schema. The logical description records a stable codec identity and version, plus serializable metadata. It never records an arbitrary function. Database-specific expressions and other non-portable behavior are identified explicitly and are not treated as client-compatible by default.

Record the gap. Build no API.

`okm catalog export` writes a snapshot derived from the schema source (D277). The file is JSON. `catalogHash` is the physical catalog hash. `logical` is `namespace`, `name`, and `format`, and it is not that hash (R5). A table entry is a namespace, a name, and columns (`name`, `type`, `nullable`). There is no function, no default, no expression, and no connection URL. A dependent points `defineConfig({ external })` at the file. That file is the verification input. It is not the logical description this section names: keys, including composite keys, relations, codecs, defaults, client-generated id rules, and a schema version are still absent. There is no sync API.

## R2. Transactions with a stated atomicity scope

Verify across drivers: an atomic `batch`, an interactive `tx` where the driver supports one, nested savepoints, rollback, affected-row behavior, and `outcome_unknown` (a COMMIT was sent and the result never arrived). State exactly what `batch()` guarantees: ORM-issued statements, or any SQL, DDL included. There is no universal atomicity claim. An unsupported case is refused explicitly. Test COMMIT loss on each driver.

## R3. Primary keys and client-generated ids

Primary keys are stable, a composite key included. A client generator (`uuidv4`, `uuidv7`, `okid`) produces the id before insert. Retrying the same write is a different scope from retrying a whole transaction callback (a serialization failure or a deadlock), where an id generated inside the callback can change. The same logical operation keeps its id across every scope for which that is promised. An unsupported scope is a documented gap. A stable id does not make a repeat idempotent. Define and test the repeat's outcome per driver: a known conflict code, or an explicit conflict policy.

## R4. Conformance matrix

Each behavior is recorded per dialect as same, differs, or unsupported, with the test id. There is no silent emulation. The shared SQL layer admits a rule only when every dialect row is green. [`compatibility.md`](compatibility.md) covers drivers and Postgres versions. It is not this matrix.

## R5. Two identities

Physical catalog and migration identity is the catalog hash plus the applied-migration state in `okm_meta`. Logical schema identity is separate. A hash says equal or not equal. It cannot say older, newer, or diverged. Those states need migration lineage or known schema versions, defined before they are claimed. Pending operations across upgrades belong to the OKEngine runtime.

## R6. Consumer writes in the same transaction

Reuse `tx()`. The architecture appears to support a consumer-owned table registered in the client schema. That support is not proven until an integration test confirms commit, rollback, and nested savepoints with domain writes and consumer writes together. An unregistered table, or another transaction path, stays unproven. If one is required, it is a separate gap and needs a decision.

## R7. Tests travel with capabilities

A pull request that adds or changes a capability carries its conformance rows. Review rejects a dialect change or a transaction change that arrives without them.
