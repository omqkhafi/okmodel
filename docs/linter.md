# Linter

The linter reads a migration plan and the catalogs before and after it. It does not connect to the database. A finding names the step, the code, why it fired, and the fix.

```text
error OKM1511 step 1: drops a table -- fix: Stop reading the table in an expand migration, then drop it in a later contract.
```

`error` fails the command. `warning` prints and the command still succeeds. The place is `step N` when the step has one statement, `step N statement M` when it has more, and `table.column` for a type preference. `okm migrate apply` prefixes the place with the migration id (`0001_drop step 1`).

## Where it runs

| Command | What it does with findings |
| --- | --- |
| `okm generate` | Writes the migration file and prints findings. An error finding exits 1 after the write; stderr says `okm migrate apply` will refuse until it is fixed. A warning does not change the exit code. |
| `okm migrate plan` | Prints the plan, then the findings. An error finding exits non-zero. |
| `okm check` | Prints findings. An error finding is OKM1510. Type preferences run here. |
| `okm migrate apply` | Lints migrations that still have a step missing from `okm_history` on the selected target, including a file you edited by hand. A migration that target already applied is left as it ran. Reading `okm_history` comes first; when the table does not exist, every migration is pending. An unresolved error is OKM1510 before any DDL or data statement. |
| `okm migrate check` | Lints the whole history. An error is OKM1510. `defineConfig({ lintFrom })` skips files before that migration id. Apply does not read `lintFrom`. |

A database that has never been pushed has no `okm_meta`. `okm check` skips the drift comparison for that database and still prints lint findings.

## Row estimates

`okm migrate plan` prints a row estimate on the lock line when a selected target is reachable (D194). One configured target is selected. Several targets need `--target`. The number is `pg_class.reltuples` for each table the step names. The command does not run `count(*)` and does not scan the table.

```text
-- lock: ACCESS EXCLUSIVE on tasks, about 4.2M rows
-- lock: ACCESS EXCLUSIVE on tasks, rows unknown (table not analyzed)
-- lock: ACCESS EXCLUSIVE on notes, new table
-- lock: ROW EXCLUSIVE on tasks, about 25K rows, about 25 batches
-- lock: SHARE UPDATE EXCLUSIVE on tasks, about 12 rows; safe rewrite applied
```

`reltuples` of `-1` means the table has not been analyzed. A name that is not in `pg_class` is `new table`. A step the planner emitted as a safe rewrite (D193) is labelled `safe rewrite applied`. `ACCESS EXCLUSIVE` on a table with more than 1,000,000 estimated rows, when that step is not a safe rewrite, adds `note: more than 1000000 estimated rows`. That note is not a lint finding.

No target, several targets and no `--target`, or a target that cannot be reached prints the lock alone and does not error. The query runs in a read-only transaction. Plan is a read-only command: a protected target is allowed, and a pooler host is not refused.

The linter does not read the estimate. `okm generate` stays offline. The SQL file, the catalog file, and `okm_history` do not store it. A partitioned table or an inheritance parent is estimated from that relation's own `reltuples`, not from its children, and the number is only as fresh as the last analyze.

## Override

Put the line on the step, directly above its statements. The reason is the text after the colon.

```sql
-- okm-allow OKM1511: the table is empty and nothing reads it
drop table "public"."notes";
```

An override silences only the code it names, on every statement of that step. A missing or empty reason, or a code no statement triggered, is OKM1510 and does not silence the finding.

## How hand-edited SQL is judged

The linter splits each step into statements before the rules run (D211). Comments are not part of a statement. `--` runs to the end of the line. `/* */` nests. A semicolon splits statements only at the top level. A semicolon inside a string, a quoted identifier, a comment, or a dollar quote does not.

`standard_conforming_strings` is assumed on. `okm migrate apply` reads the setting and refuses when it is off. A plain `'...'` ends on one quote, and `''` is a quote inside it. `E'...'` keeps backslash escapes. `"..."` is an identifier, and `""` is a quote inside it. A dollar quote runs until the same tag. A different tag inside it is text, so it does not end the outer quote. An unterminated string, identifier, block comment, or dollar quote is one opaque tail. The split does not throw.

Each statement is linted. The place stays `step N` when the step has one statement. It is `step N statement M`, counting from 1, when the step has more. Step numbers do not change. Rules that look at earlier or later steps see the statements of those steps, with comments removed. A later `USING INDEX`, and a `VALIDATE` after `NOT VALID`, still count when they sit in another statement of that step or after a comment. Words inside a comment do not.

`-- okm-allow CODE: reason` stays a line on the step. It silences that code on every statement of the step that triggers it. A code that no statement triggers is OKM1510.

`DO` and `CALL` are data-touching statements. The body is not analysed, so each is OKM1542. Only `-- okm-allow OKM1542: reason` silences that finding. A dollar-quoted body inside `CREATE FUNCTION` or `CREATE PROCEDURE` stays inside that statement. It is not linted as its own statements. A SQL-standard `BEGIN ATOMIC` body does too: semicolons inside it do not split the statement, and a nested `CASE ... END` does not close the body.

`ALTER TABLE … ALTER COLUMN … TYPE` is the same type change as `SET DATA TYPE`, with or without `USING`. OKM1524, OKM1527, OKM1533, and OKM1538 see both forms.

OKM1550 flags a statement that weakens `rlsTenancy`: `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, `CREATE POLICY` or `ALTER POLICY` on a tenant table whose expression is not the one okm emits (`USING (true)`, `USING (1=1)`, `USING ((true))`, `USING (true OR false)`, `ALTER POLICY … TO public USING (1=1)`, an extra permissive policy, or `AS RESTRICTIVE`), `ALTER ROLE` or `CREATE ROLE` that grants `BYPASSRLS`, and `ALTER TABLE … OWNER TO` when that table has a policy in the catalog. `USING (true)` and `WITH CHECK (true)` keep their own reasons. A policy named `{table}_tenant` or `{table}_unscoped_select` with the emitted expression is clean, and `WITH CHECK` may be omitted. `NOBYPASSRLS` does not match. A line break of `\n`, `\r\n`, or `\r` is the same statement. `-- okm-allow OKM1550: reason` is the only bypass, and the reason must not be empty.

OKM1551 flags transaction control in a step: `COMMIT`, `COMMIT PREPARED`, `END`, `END WORK`, `END TRANSACTION`, `ABORT`, `ROLLBACK`, `ROLLBACK PREPARED`, `BEGIN`, `BEGIN WORK`, `BEGIN TRANSACTION`, `START TRANSACTION`, and `PREPARE TRANSACTION`, including when it follows another statement and including a `COMMIT` or `ROLLBACK` inside a `DO` body. A `COMMIT` or `ROLLBACK` inside `CREATE FUNCTION` or `CREATE PROCEDURE` is not this rule. A `BEGIN ATOMIC` body on those statements is not this rule, including its closing `END`. `BEGIN ATOMIC` elsewhere is still `BEGIN`. A bare `BEGIN` or `END` inside plpgsql is not this rule. `END IF`, `END LOOP`, `END CASE`, and `ROLLBACK TO` are not this rule. `-- okm-allow OKM1551: reason` lets apply run the step. `okm migrate check` still refuses it, because the replay is one transaction that always rolls back.

OKM1557 flags a committed step that cannot be made re-runnable. A step is committed when it is not a backfill and either the header says `-- transactional: false` or the statement cannot share a transaction (`VACUUM`, `ALTER TYPE … ADD VALUE`, concurrent index create or drop). A built-in probe for that kind, including a raw `CREATE INDEX CONCURRENTLY` or `DROP INDEX CONCURRENTLY` the probe can parse, is enough. A `-- probe:` line is the other way. A transactional step never triggers it, and neither does a planner step whose kind already has a probe. `-- okm-allow OKM1557: reason` silences the finding and records that a failure of that step needs a person. An empty reason does not.

OKM1558 flags a `-- probe:` that is empty, is not one read-only `SELECT` (a `WITH` whose body writes, `SELECT INTO`, and `FOR UPDATE` or `FOR SHARE` included), has more than one statement, or sits on a transactional or backfill step. A semicolon inside a quote is still one statement. A probe on a step that never leaves the migration transaction is refused, so a file cannot claim protection it does not use. `-- okm-allow OKM1558: reason` silences it. An empty reason does not.

A blank line ends a step. A blank line inside a quote, a dollar quote, a block comment, or a `BEGIN ATOMIC` routine body stays in the step, including a `--` line while that quote or body is still open.

`okm migrate plan`, `okm migrate apply`, and `okm migrate check` use this linter. Check and apply read the migration files. Plan lints the plan it generates. An error finding is OKM1510 in each command. The planner still writes one statement per step, so a generated migration lints as before.

## Severity

Destructive, backward-incompatible, and data-dependent rules are errors. OKM1534, OKM1535, OKM1536, and OKM1537 are errors too, and they fire only when the statement is not the safe form (D193). OKM1538 stays a warning, and only when the type change rewrites the heap (D276). `varchar(n)` widening, `varchar` to `text`, `text` or `varchar` to unconstrained `varchar` or `bpchar`, a numeric precision increase at the same scale, `numeric(p,s)` to `numeric`, `integer` to `oid`, `cidr` to `inet`, `xml` to `text`, an unconstrained domain over the old type, and any domain to its base do not. A `USING` expression that is not a plain cast of the column still does. `timestamp` to `timestamptz` still does. There is no safe form in this version. The expand/contract recipe is [a type change that rewrites the table](type-change.md) (D285). OKM1524 already requires a reason. OKM1552 is a warning from `okm migrate check` when a domain check or a `LANGUAGE sql` function body reprints. The offline linter does not guess that reprint. Type preferences are warnings, and they run on the schema in `okm check`, not on a migration file.

## Safe form

On a table that already exists, the planner writes the form these rules accept. A new table keeps the plain statements. The linter recognises the form from the SQL, not from a planner flag, so a hand-edited file is judged the same way.

- An index is `CREATE INDEX CONCURRENTLY` or `DROP INDEX CONCURRENTLY`.
- A check or foreign key is `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` in its own step.
- `SET NOT NULL` follows a validated `CHECK (column IS NOT NULL)` that was added `NOT VALID`.
- A unique constraint or primary key is `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT … USING INDEX`.

A `VALIDATE` that follows a `widen-check` (a picklist that gained a value) does not fire OKM1531. Narrowing a check still does. `VALIDATE` of the temporary `CHECK (col IS NOT NULL) NOT VALID` from the safe `SET NOT NULL` rewrite also does not: that scan is intentional and paired with the lock-safe sequence (D289). `VALIDATE` of a check whose `NOT VALID` add is earlier in the same migration on a column added in that migration with a constant default (or a nullable column without a default) does not fire either: existing rows only see that default or null (D301). A volatile default, or a check on a column that already existed, stays OKM1531. OKM1528 fires on the concurrent unique index that a later `USING INDEX` consumes, and on a plain `ADD CONSTRAINT UNIQUE` or `PRIMARY KEY` that is not `USING INDEX`. It does not fire on the `USING INDEX` step, which does not scan. OKM1529 fires on a unique index that no later step consumes.

OKM1706 and OKM1823 are not rules in this table. With `indexes: false` or `tenantIndexes: false`, a tenant index that does not lead with the tenant key fails when the schema is built. The default prefixes the key (D306). `.global("reason")` does not raise OKM1706. `security: "definer"` without `searchPath` fails on `fn()`. Both are declaration-time checks.

## Codes

| Code | Category | Severity | What it flags |
| --- | --- | --- | --- |
| OKM1510 | refusal | error | Unresolved lint error, or an override with an empty reason or a code no statement in the step triggered |
| OKM1511 | destructive | error | Drop table |
| OKM1512 | destructive | error | Drop column |
| OKM1513 | destructive | error | Drop enum |
| OKM1514 | destructive | error | Drop domain |
| OKM1515 | destructive | error | Drop function |
| OKM1516 | destructive | error | Drop view |
| OKM1517 | destructive | error | Drop extension. A dependent still in the catalog is OKM1814 before this finding |
| OKM1518 | destructive | error | Drop materialized view |
| OKM1519 | backward-incompatible | error | Rename column |
| OKM1523 | backward-incompatible | error | Rename table |
| OKM1524 | backward-incompatible | error | Column type change, including `ALTER COLUMN … TYPE` and `SET DATA TYPE` |
| OKM1525 | backward-incompatible | error | New NOT NULL column with no default on an existing table |
| OKM1526 | backward-incompatible | error | Remove a default |
| OKM1527 | backward-incompatible | error | Shrink a character length |
| OKM1528 | data-dependent | error | New unique or primary-key constraint on an existing table |
| OKM1529 | data-dependent | error | New unique index on an existing table |
| OKM1531 | data-dependent | error | New check that validates existing rows |
| OKM1532 | data-dependent | error | New foreign key that validates existing rows |
| OKM1533 | data-dependent | error | Narrowing type change |
| OKM1534 | locking | error | Non-concurrent index create on an existing table |
| OKM1535 | locking | error | Add check without `NOT VALID` |
| OKM1536 | locking | error | Add foreign key without `NOT VALID` |
| OKM1537 | locking | error | `SET NOT NULL` that is not preceded by a validated `CHECK (col IS NOT NULL)` |
| OKM1538 | locking | warning | Type change that rewrites the heap (D276). No safe form in this version. The recipe is [a type change that rewrites the table](type-change.md) (D285) |
| OKM1539 | type-preference | warning | `timestamp` without time zone |
| OKM1540 | type-preference | warning | `varchar(n)` where `text` would do |
| OKM1542 | data-dependent | error | `insert`, `update`, `delete`, `merge`, `truncate`, or a `with` that writes, outside a backfill step. `DO` and `CALL` too: the body is not analysed |
| OKM1550 | destructive | error | `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, `CREATE` or `ALTER POLICY` on a tenant table that is not the emitted predicate, `BYPASSRLS` on a role, or `OWNER TO` on a tenant table |
| OKM1551 | destructive | error | `COMMIT`, `END`, `ABORT`, `ROLLBACK`, `BEGIN`, `START TRANSACTION`, `PREPARE TRANSACTION`, or `COMMIT PREPARED` inside a step, including a `DO` body. A function or procedure body, including `BEGIN ATOMIC`, is not this. `BEGIN ATOMIC` outside `CREATE FUNCTION` or `CREATE PROCEDURE` is still `BEGIN`. `ROLLBACK TO` is not this. `-- okm-allow OKM1551: reason` lets apply run it. `okm migrate check` still refuses it |
| OKM1557 | locking | error | A committed step (not a backfill) with no built-in probe and no `-- probe:`. A raw concurrent index the built-in probe can parse does not. A transactional step does not. `-- okm-allow OKM1557: reason` records that a failure needs a person |
| OKM1558 | locking | error | `-- probe:` is empty, is not one read-only `SELECT`, has more than one statement, or sits on a transactional or backfill step. `-- okm-allow OKM1558: reason` silences it |
| OKM1543 | type-preference | warning | `serial` or a `nextval` default |
| OKM1544 | type-preference | warning | `json` where `jsonb` is available |
| OKM1545 | type-preference | warning | Identity that is not generated always |
| OKM1552 | reprint | warning | Domain check or `LANGUAGE sql` function body whose stored text differs (D276). `okm migrate check` reports it. `-- okm-allow OKM1552: reason` silences it. An empty reason, or an allow when the text matches, is OKM1510. A reprinted domain check is sealed before the OKM1547 plan (B-37) |

OKM1520, OKM1521, OKM1522, OKM1530, OKM1541, OKM1546, OKM1547, OKM1548, and OKM1549 are other guards in this range. They are listed in §21. What this linter does not do yet is in [known limits](known-limits.md#migrations). Reference rows are not migration steps, so OKM1542 does not see them. See [provisioning](provisioning.md).
