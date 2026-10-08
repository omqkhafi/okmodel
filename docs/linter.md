# Linter

The linter reads a migration plan and the catalogs before and after it. It does not connect to the database. A finding names the step, the code, why it fired, and the fix.

```text
error OKM1511 step 1: drops a table -- fix: Stop reading the table in an expand migration, then drop it in a later contract. Or allow OKM1511 with a reason.
```

`error` fails the command. `warning` prints and the command still succeeds. The place is `step N` when the step has one statement, `step N statement M` when it has more, and `table.column` for a type preference. `okm migrate apply` prefixes the place with the migration id (`0001_drop step 1`).

## Where it runs

| Command | What it does with findings |
| --- | --- |
| `okm generate` | Writes the migration file and prints findings. It does not refuse. |
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

`DO` and `CALL` are data-touching statements. The body is not analysed, so each is OKM1542. Only `-- okm-allow OKM1542: reason` silences that finding. A dollar-quoted body inside `CREATE FUNCTION` or `CREATE PROCEDURE` stays inside that statement. It is not linted as its own statements.

`ALTER TABLE … ALTER COLUMN … TYPE` is the same type change as `SET DATA TYPE`, with or without `USING`. OKM1524, OKM1527, OKM1533, and OKM1538 see both forms.

A blank line ends a step. A blank line inside a quote, a dollar quote, or a block comment stays in the step, including a `--` line while that quote is still open.

`okm migrate plan`, `okm migrate apply`, and `okm migrate check` use this linter. Check and apply read the migration files. Plan lints the plan it generates. An error finding is OKM1510 in each command. The planner still writes one statement per step, so a generated migration lints as before.

## Severity

Destructive, backward-incompatible, and data-dependent rules are errors. OKM1534, OKM1535, OKM1536, and OKM1537 are errors too, and they fire only when the statement is not the safe form (D193). OKM1538 stays a warning: a type change that rewrites the table has no safe form in this version, and OKM1524 already requires a reason. Type preferences are warnings, and they run on the schema in `okm check`, not on a migration file.

## Safe form

On a table that already exists, the planner writes the form these rules accept. A new table keeps the plain statements. The linter recognises the form from the SQL, not from a planner flag, so a hand-edited file is judged the same way.

- An index is `CREATE INDEX CONCURRENTLY` or `DROP INDEX CONCURRENTLY`.
- A check or foreign key is `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` in its own step.
- `SET NOT NULL` follows a validated `CHECK (column IS NOT NULL)` that was added `NOT VALID`.
- A unique constraint or primary key is `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT … USING INDEX`.

A `VALIDATE` that follows a `widen-check` (a picklist that gained a value) does not fire OKM1531. Narrowing a check still does. The temporary not-null check does too: nulls in the column fail that validate. OKM1528 fires on the concurrent unique index that a later `USING INDEX` consumes, and on a plain `ADD CONSTRAINT UNIQUE` or `PRIMARY KEY` that is not `USING INDEX`. It does not fire on the `USING INDEX` step, which does not scan. OKM1529 fires on a unique index that no later step consumes.

OKM1706 and OKM1823 are not rules in this table. A tenant index that does not lead with the tenant key fails when the schema is built. `security: "definer"` without `searchPath` fails on `fn()`. Both are declaration-time checks.

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
| OKM1538 | locking | warning | Type change that rewrites the table. No safe form in this version |
| OKM1539 | type-preference | warning | `timestamp` without time zone |
| OKM1540 | type-preference | warning | `varchar(n)` where `text` would do |
| OKM1542 | data-dependent | error | `insert`, `update`, `delete`, `merge`, `truncate`, or a `with` that writes, outside a backfill step. `DO` and `CALL` too: the body is not analysed |
| OKM1543 | type-preference | warning | `serial` or a `nextval` default |
| OKM1544 | type-preference | warning | `json` where `jsonb` is available |
| OKM1545 | type-preference | warning | Identity that is not generated always |

OKM1520, OKM1521, OKM1522, OKM1530, OKM1541, OKM1546, OKM1547, OKM1548, and OKM1549 are other guards in this range. They are listed in §21. What this linter does not do yet is in [known limits](known-limits.md#migrations). Reference rows are not migration steps, so OKM1542 does not see them. See [provisioning](provisioning.md).
