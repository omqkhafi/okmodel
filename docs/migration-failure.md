---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: [OKM1553, OKM1554, OKM1555, OKM1556, OKM1557, OKM1558]
---
# When a migration fails

`okm migrate apply` keeps going only when it can prove what the database already has. A step that runs inside a transaction is rolled back with its history row, so the next apply runs it again. A backfill keeps its cursor in `okm_backfill` and continues from that key. A step that cannot run inside a transaction is different: Postgres may commit the DDL and then lose the connection before the history row is written.

<!-- support: steps.resumable -->
Postgres: native. Proof passes (`concurrent index create and drop run outside the transaction, and validate stays in it`).
<!-- /support -->

`okm migrate status` still prints `failed at step N (resume with okm migrate apply)`. That `N` is the stored step index, starting at 0. Apply's own error starts `Migration <id> failed at step N`, and that `N` starts at 1.

## What is stored

`okm_history` is the only done record. One row means that step is finished. The columns are:

| Column | Meaning |
| --- | --- |
| `migration_id` | Migration file id, such as `0001_init`. |
| `step_index` | 0-based index in that file. |
| `class` | `expand`, `contract`, or `unclassified`. |
| `catalog_hash` | Catalog hash recorded with the step. |
| `applied_at` | When the row was inserted. |

The primary key is `(migration_id, step_index)`.

`okm_steps` exists only while a committed step is in flight or broken. The row is deleted in the same transaction that inserts the history row. A transactional step and a backfill never get a row here. The columns are:

| Column | Meaning |
| --- | --- |
| `migration_id` | Migration file id. |
| `step_index` | 0-based index in that file. |
| `kind` | Planner kind, or `raw-sql` when the step has none. |
| `sql_hash` | SHA-256 of the statement with LF line endings, trimmed. |
| `state` | `started`, `failed`, or `retry`. |
| `attempt` | How many times the step was started. |
| `started_at` | When this attempt started. |
| `finished_at` | When the attempt failed, or null while it is running. |
| `runner` | Backend pid and OKModel version. Informational. |
| `error_code` | OKM code from the failure, or null. |
| `error_text` | Failure text, control characters removed, at most 500 characters. |

The primary key is `(migration_id, step_index)`.

The step id everywhere else is `migrationId:stepIndex`, with the same 0-based index. `okm migrate status` prints that id. `okm migrate resolve` takes it.

## What the next apply does

The advisory lock is held. For each pending committed step the marker says where to look. The probe decides.

| Marker | Probe | Next apply |
| --- | --- | --- |
| none | | Run the statement. |
| `started` or `failed` | `applied` | Write the history row. Run no SQL. |
| `started` or `failed` | `absent` | Run the statement. |
| `started` or `failed` | `partial` | Drop the partial result, then run the statement. |
| `started` or `failed` | `unknown` | Stop. The step needs a person (OKM1553). |
| `retry` | `unknown` | Run the statement. A person allowed that. |
| `retry` | anything else | Same as `started`. |

A hash that does not match the file is OKM1556. Apply runs no SQL.

Postgres can probe these kinds:

- `create-index` with `CONCURRENTLY`. Missing is `absent`. `indisvalid = false` is `partial`, and cleanup is `DROP INDEX CONCURRENTLY` after checking that no build is still running. A valid index is `applied` only when its definition matches the statement. If that cannot be proved, the probe is `unknown`. `okm check`, `okm push`, and `okm migrate baseline` do not treat that invalid index as the schema's index. They report it as INVALID, and name an `okm_steps` row that is still `started`.
- `drop-index` with `CONCURRENTLY`. Present is `absent` (the drop has not happened). Absent is `applied`.
- `add-constraint`. An equal constraint definition is `applied`. A different definition is `unknown`. Missing is `absent`.
- `validate-constraint`. `convalidated` true is `applied`. False is `absent`.
- `add-enum-value`. The label present is `applied`. Missing is `absent`.

Every other kind is `unknown` after a failure, unless the step declares a probe. The statement is not run again until a person marks it `retry` or records it as applied.

## Step kinds

<!-- steps -->
Generated from `STEP_KINDS`, `postgresHasProbe`, and `unitMode`. Do not edit by hand.

| Kind | Transactional | Built-in probe | Resume | Code |
| --- | --- | --- | --- | --- |
| `create-table` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-table` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-column` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-column-required` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-column` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-column-type` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-not-null` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-not-null` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-default` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-default` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-identity` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-identity` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-identity-always` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-identity-by-default` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-constraint` | yes | yes | rolls back with the history row; a committed copy follows the probe | OKM1553 |
| `validate-constraint` | yes | yes | rolls back with the history row; a committed copy follows the probe | OKM1553 |
| `drop-constraint` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-not-null-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `rename-constraint` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `widen-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `narrow-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-index` | no when CONCURRENTLY | when CONCURRENTLY | a plain statement rolls back; CONCURRENTLY follows the probe, and partial drops the index and rebuilds | OKM1553, OKM1556 |
| `drop-index` | no when CONCURRENTLY | when CONCURRENTLY | a plain statement rolls back; CONCURRENTLY follows the probe | OKM1553, OKM1556 |
| `rename-index` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-sequence` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-sequence` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-enum` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `recreate-enum` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-enum-value` | no | yes | follows the probe: applied writes history, absent runs the statement, unknown stops | OKM1553, OKM1556 |
| `rename-enum` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-enum` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `set-enum-column` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-domain` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-domain` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `add-domain-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `validate-domain-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-domain-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `rename-domain-check` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-extension` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-extension` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `update-extension` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `move-extension` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-function` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-function` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `replace-function` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-trigger` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-trigger` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-view` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-view` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `replace-view` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-matview` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-matview` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `refresh-matview` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-role` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `alter-role` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `grant` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `revoke` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `grant-default` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `revoke-default` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `rename-table` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `rename-column` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `rename-sequence` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `backfill-expand` | no | no | continues from the last key in okm_backfill; no okm_steps row | — |
| `backfill-contract` | no | no | continues from the last key in okm_backfill; no okm_steps row | — |
| `enable-rls` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `create-policy` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `drop-policy` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `disable-rls` | yes | no | rolls back with the history row; the next apply runs the step again | — |
| `raw-sql` | yes, unless the statement cannot share a transaction | when CONCURRENTLY | rolls back when the statement can share a transaction; a concurrent index follows the probe; any other committed statement stops until a declared probe or a person marks retry | OKM1553, OKM1556, OKM1557 |
<!-- /steps -->

## Declared probe

A hand-written step may carry one line above its statement, in the same comment style as `-- lock:`:

```sql
-- probe: select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'notes')
-- transactional: false
create table notes (id integer);
```

The probe is one read-only `SELECT` (or `WITH … SELECT`). It returns exactly one boolean. True means the step has already been applied. False means it has not. NULL, more than one row, a non-boolean, or an error is `unknown`, never applied. Apply runs it inside `begin read only` and rolls the transaction back. The text is not part of the statement hash.

A built-in probe for the step's kind still wins. The declared line is not consulted.

There is no cleanup for a declared probe. A raw step has to be atomic. If a crash can leave a partial result, the author repairs that through `okm migrate resolve` after looking at the database. `okm migrate resolve --applied` uses the declared probe, so that step no longer needs `--accept-unverified`. A probe that is not `applied` is still OKM1554.

OKM1557 refuses a committed step that has no built-in probe and no `-- probe:`. OKM1558 refuses a probe that is empty, is not one read-only `SELECT`, has more than one statement, or sits on a step that stays inside a transaction. `-- okm-allow OKM1557: reason` records that a failure of that step needs a person. An empty reason does not silence the finding.

## Resolve

`okm migrate resolve <migrationId>:<stepIndex>` takes the same advisory lock as apply. It only works when an `okm_steps` row exists.

- Record the step as applied after finishing it by hand. Where a probe exists, including a `-- probe:` line, a result other than `applied` is OKM1554. Where no probe exists, the command is OKM1555 until the invocation explicitly accepts that the database was checked. A declared probe is a probe, so that step does not need the unverified acceptance.
- Mark the row `retry`. The next apply probes first where a probe exists, and otherwise runs the step.

There is no skip. Skipping would write a done row for a change that is not in the database, and the next migration would be planned on top of that lie. Finish the change, or mark the step to run again.

A protected target treats this as a history repair. The invocation has to allow a protected target.
