# Linter

The linter reads a migration plan and the catalogs before and after it. It does not connect to the database. A finding names the step, the code, why it fired, and the fix.

```text
error OKM1511 step 1: drops a table -- fix: Stop reading the table in an expand migration, then drop it in a later contract. Or allow OKM1511 with a reason.
```

`error` fails the command. `warning` prints and the command still succeeds. The place is `step N` for a statement and `table.column` for a type preference. `okm migrate apply` prefixes the place with the migration id (`0001_drop step 1`).

## Where it runs

| Command | What it does with findings |
| --- | --- |
| `okm generate` | Writes the migration file and prints findings. It does not refuse. |
| `okm migrate plan` | Prints the plan, then the findings. An error finding exits non-zero. |
| `okm check` | Prints findings. An error finding is OKM1510. Type preferences run here. |
| `okm migrate apply` | Lints the files it is about to run, including a file you edited by hand, and refuses an unresolved error with OKM1510 before any statement. |

A database that has never been pushed has no `okm_meta`. `okm check` skips the drift comparison for that database and still prints lint findings.

## Override

Put the line directly above the statement. The reason is the text after the colon.

```sql
-- okm-allow OKM1511: the table is empty and nothing reads it
drop table "public"."notes";
```

An override silences only the code it names. A missing or empty reason, or a code the statement did not trigger, is OKM1510 and does not silence the finding.

## Severity

Destructive, backward-incompatible, and data-dependent rules are errors. Locking rules are warnings until the planner emits the safe form (P50b, D192). Type preferences are warnings, and they run on the schema in `okm check`, not on a migration file.

## Codes

| Code | Category | Severity | What it flags |
| --- | --- | --- | --- |
| OKM1510 | refusal | error | Unresolved lint error, or an override with an empty reason or a code the statement did not trigger |
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
| OKM1524 | backward-incompatible | error | Column type change |
| OKM1525 | backward-incompatible | error | New NOT NULL column with no default on an existing table |
| OKM1526 | backward-incompatible | error | Remove a default |
| OKM1527 | backward-incompatible | error | Shrink a character length |
| OKM1528 | data-dependent | error | New unique or primary-key constraint on an existing table |
| OKM1529 | data-dependent | error | New unique index on an existing table |
| OKM1531 | data-dependent | error | New check that validates existing rows |
| OKM1532 | data-dependent | error | New foreign key that validates existing rows |
| OKM1533 | data-dependent | error | Narrowing type change |
| OKM1534 | locking | warning | Non-concurrent index create on an existing table |
| OKM1535 | locking | warning | Add check without `NOT VALID` |
| OKM1536 | locking | warning | Add foreign key without `NOT VALID` |
| OKM1537 | locking | warning | `SET NOT NULL` on an existing column |
| OKM1538 | locking | warning | Type change that rewrites the table |
| OKM1539 | type-preference | warning | `timestamp` without time zone |
| OKM1540 | type-preference | warning | `varchar(n)` where `text` would do |
| OKM1543 | type-preference | warning | `serial` or a `nextval` default |
| OKM1544 | type-preference | warning | `json` where `jsonb` is available |
| OKM1545 | type-preference | warning | Identity that is not generated always |

OKM1520, OKM1521, OKM1522, OKM1530, OKM1541, and OKM1542 are already other guards in this range. They are listed in §21. What this linter does not do yet is in [known limits](known-limits.md#migrations).
