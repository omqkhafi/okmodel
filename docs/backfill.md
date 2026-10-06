# Backfill

A backfill is a step in a migration file (D59, D195). It is not a function exported from `okmodel`, and there is no `okm backfill` command. `okm migrate plan` and `okm generate` write the step. `okm migrate apply` runs it.

The statement stays one `UPDATE`. It runs outside the migration transaction, one transaction per batch, and a later apply continues from the last committed key.

## Step format

The header uses the same comment style as `-- lock:` and `-- transactional:`.

```sql
-- class: expand
-- kind: backfill-expand
-- action: backfill
-- lock: ROW EXCLUSIVE
-- backfill table="public"."tasks" key="id" batch=1000
-- transactional: false
update "public"."tasks" set "status" = 'b' where "status" = 'a' and ($1::text is null or "id" > $1::bigint) and ($2::text is null or "id" <= $2::bigint);
```

`table` is the schema-qualified name. `key` is the primary key, one column or several separated by commas, in key order. `batch` is how many rows one transaction may change. A hand-written step uses the same header.

`$1` is the exclusive lower bound. `$2` is the inclusive upper bound. Null opens that side: the first batch passes null for `$1`, and the last batch passes null for `$2`. The runner finds each boundary with one keyset query (`select` the key `where` it is past the last boundary, `order by` the key, `offset batch - 1`, `limit 1`). It does not count the table and it does not scan the table once per batch.

The key can be any orderable primary key, including `uuid` and a composite key. A composite bound is a row comparison. The stored key is text: one column is its text form, and several columns are a JSON array of their text forms. A table with no primary key is OKM1546 at plan time.

## Idempotence

A finished batch must change nothing when it runs again. The planner writes that into the statement: a removed value is `where` the column still holds the old value, and a volatile-default fill is `where` the new column `is null`, both plus the key range. A hand-written `UPDATE` has to meet the same rule. Resume does not repeat a finished batch; the predicate is what makes a repeated batch harmless if it does run.

## Batch, pause, and timeout

`defineConfig({ backfill: { batchSize, pauseMs, statementTimeoutMs } })` supplies the defaults. Omitted fields use 1,000 rows, no pause, and 30 seconds. `batch=` in the step header overrides `batchSize` for that step. The pause and the statement timeout are apply-time settings. They are not written into the file.

Each batch runs under `statement_timeout` and `lock_timeout`. A lock timeout retries that batch with the same backoff as any other step. Any other error stops the step. The previous checkpoint stays. A timed-out batch rolls back and does not lose the last committed key.

## Resume

Apply creates `okm_backfill` with `create table if not exists`, the same way it creates `okm_history`. An existing database gains the table on the next apply. No migration file is required.

| Column | Meaning |
| --- | --- |
| `migration_id` | Migration file id |
| `step_index` | Step index in that file |
| `last_key` | Last committed boundary, as text. Null until a batch has committed a key |
| `rows_touched` | Rows the committed batches changed |
| `batches` | Committed batches |
| `state` | `running` or `done` |
| `updated_at` | When that row was written |

The primary key is `(migration_id, step_index)`.

After every committed batch the runner writes that row. The final batch also writes the normal `okm_history` row, in the same transaction, and sets `state` to `done`. A step already in `okm_history` is skipped. A rerun loads `last_key` and does not issue a finished batch again. `okm_history` is unchanged.

`okm migrate status` keeps its target columns. Under them, an unfinished backfill prints the migration, the step, the rows so far, the last key, and the state. A finished step is not listed there.

A protected target refuses a backfill unless `--allow-protected`. That check runs before every batch, so a target that becomes protected between batches stops at the next one. The committed batches stay.

The row estimate on `okm migrate plan` (`about N rows, about M batches`) is display only (D194). It is not stored, and resume does not read it.

## What is not built

Iterating tenants is schema-per-tenant and database-per-tenant (M5). A backfill on a table with column tenancy is one pass over the whole table. See [known limits](known-limits.md).

The control database in §19.5 arrives with the multi-target runner in M5. This version stores the checkpoint on the target.

Bounded concurrency, canary, and class flags are M5. `okm migrate apply` runs `TargetRunner` with a list of one target.
