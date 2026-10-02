# Migrations spike findings

Question: does a catalog diff, applied to a real Postgres, land on the target catalog, and can two catalogs be compared when Postgres rewrites expressions?

Engine: Postgres 17 from `bun run db:up`. The planner lives in the private package `@okmodel/spikes`. Nothing here is published.

## What equal means

Two catalogs are equal when both have been applied and read back, and those read-backs match. Authoring SQL is not the comparison.

**Structural equality** is the normalised object: kind, identity, types, nullability, flags, partition bounds, and the expressions Postgres reprints with `pg_get_expr` (defaults, checks, generated columns, index expressions, domain checks). Owner and provenance stay on the authoring side.

**Body equality** is a scratch-database reprint. View bodies (`pg_get_viewdef`) and function bodies (`pg_get_functiondef`) are not in the structural form. They are equal when the reprints match after the concrete schema name is replaced and whitespace is collapsed. That is the only safe comparison for those texts.

The property test applies A, plans A→B, applies the plan, and compares that introspection with B applied on its own scratch schema. Both sides go through Postgres (section 19.3).

## What worked

- Seeded pairs applied on Postgres 17 introspected equal to B. The generator starts from tables, columns, indexes, checks, a generated column, an expression index, a domain check, a view, a plpgsql function, a SQL function, a trigger, and range, list, hash, or timestamptz partitions. Mutations also add or change a policy, a materialized view, a sequence, and an extension. `bun run check` runs 100 pairs. A separate run with `OKM_MIGRATION_CASES=500` ran 500 pairs, 0 failures, in 13967 ms.
- A column type change (`int8` to `int4`) and a declared rename (`title` to `name`) each drop the dependent view, index, and check, alter, then recreate them. The statements do not contain `CASCADE`. An undeclared same-type drop and add fails with OKM1530 and tells the author to declare `renamedFrom`.
- Indexes and checks are dependents of a column when their column list or expression names that column. Views and functions are dependents only when the catalog declares the edge.
- Domain `CHECK`, list partitions, hash partitions, and timestamptz range bounds round-trip. Integer bounds still come back quoted (`'0'`), and the normalised form is `0:100`. List bounds normalise to `list:1,2`. Hash bounds normalise to `hash:2:0`. Timestamptz bounds keep the literal and use `|` so the colons in the timestamp are not a separator.
- The structural drift hash ignores object order and ignores view SQL. Adding a column type change changes it. The scratch expression hash matches two spellings of the same check and changes when the check predicate changes.
- Lock claims matched `pg_locks` on a real apply. See the table below.
- A plpgsql function with no declared dependency is not dropped when its table is dropped. `DROP TABLE` succeeds. The function is still there. Calling it fails because `tasks` does not exist. With the dependency declared, the plan drops the function first.
- Policies, materialized views, and sequences round-trip through the plan. Policy `USING` text is compared as `pg_get_expr` on both scratch schemas. Materialized view bodies are scratch reprints, same as views. Sequence start, increment, and type are structural.
- Every candidate extension was available and not already installed, so none were skipped: `btree_gist`, `citext`, `hstore`, `pgcrypto`, `pg_trgm`, `unaccent`, `uuid-ossp`. The plan emits `CREATE EXTENSION` and `DROP EXTENSION`. Those statements run with `search_path` set to `public`, so a relocatable extension is not created inside the scratch schema. The fresh schema's create is `CREATE EXTENSION IF NOT EXISTS`, and only after `pg_extension` has been checked against catalog B, because an extension is database-scoped and the plan may already have installed it. The mutation installs and drops the extension object. It does not retype a column onto that extension.

## Where the scratch database is the judge

Each row is two authoring spellings of the same expression, plus a third that is a real change. "Scratch equal" means the two spellings read back the same. "Drift differs" means the third does not.

| Expression                              | Authoring differs | Scratch equal | Drift differs | Read-back                                 |
| --------------------------------------- | ----------------- | ------------- | ------------- | ----------------------------------------- |
| default `0` / `(0)`                     | yes               | yes           | yes           | `0`                                       |
| check `id > 0` / `((id > 0))`           | yes               | yes           | yes           | `CHECK ((id > 0))`                        |
| index `lower(title)` / `lower((title))` | yes               | yes           | yes           | `lower(title)`                            |
| generated `rank + 1` / `((rank + 1))`   | yes               | yes           | yes           | `(rank + 1)`                              |
| view, quoted identifiers / bare         | yes               | yes           | yes           | `SELECT id FROM t WHERE id > 0;`          |
| SQL function, spacing and `::int8`      | yes               | yes           | yes           | `count(*) AS count`, return type `bigint` |
| plpgsql body, whitespace                | yes               | yes           | yes           | `begin return 1; end`                     |
| domain check, extra parentheses         | yes               | yes           | yes           | `CHECK ((VALUE > 0))`                     |

Text equality of the source is not equality for any of these. The SQL function is the sharp case: `count(*)::int8` is stored as `count(*) AS count` returning `bigint`, so even one spelling does not match its own source. plpgsql whitespace is also reprinted, which is more than P03 assumed, but `pg_depend` still does not record the table the body reads.

## Locks

Checked on Postgres 17 by running each planned statement in a transaction and reading `pg_locks` for that backend before commit.

| Step                                                                               | Lock                                 | Blocks reads | Blocks writes |
| ---------------------------------------------------------------------------------- | ------------------------------------ | ------------ | ------------- |
| `CREATE` / `DROP` / `ALTER TABLE`, including column type, rename, add, drop, check | `AccessExclusiveLock`                | yes          | yes           |
| `CREATE` / `DROP VIEW`, `CREATE` partition                                         | `AccessExclusiveLock`                | yes          | yes           |
| `DROP INDEX`                                                                       | `AccessExclusiveLock`                | yes          | yes           |
| `CREATE INDEX`                                                                     | `ShareLock` on the table             | no           | yes           |
| `CREATE TRIGGER`                                                                   | `ShareRowExclusiveLock` on the table | no           | yes           |
| `DROP TRIGGER`                                                                     | `AccessExclusiveLock`                | yes          | yes           |
| `CREATE FUNCTION` language sql that reads a table                                  | `AccessShareLock` on that table      | no           | no            |
| plpgsql function, `CREATE` / `DROP` / `ALTER DOMAIN`                               | no user-relation lock                | no           | no            |

`ACCESS SHARE` does not block readers or writers. It conflicts only with `ACCESS EXCLUSIVE`. `LANGUAGE sql` is the function form that takes it.

## What broke

- The first ambiguous-rename check scanned the whole catalog once per added column. Diff of the 200-table fixture took 819 ms. A set lookup brought it to 5.96 ms. The pairs matched. The check was quadratic.
- A recreated partitioned table was emitted with no columns until the `CREATE TABLE` included every column of the new table, not only columns that were new identities. Range-to-list and range-to-timestamptz pairs failed until that was fixed. They pass now.
- View and function reprints include or omit the schema name depending on `search_path`. Comparing them with `search_path` still set to one of the two scratch schemas reported a false mismatch. Both reads now run with `search_path` set to `public`.
- Enabling row security to add a policy recreates `tasks`. That drop set includes `touch()`, and the trigger was omitted because `DROP TABLE` would remove it. `DROP FUNCTION touch()` then failed: the trigger still depended on it. The plan now drops that trigger first. Seed 8 was the pair that found it (`added [policy tasks.tasks_read]; changed [table tasks]`). The 500-case run after the fix had no failures.

## Classification

| Item                             | Class              | Evidence                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift hash versus source SQL     | contradiction      | The structural hash is unchanged when only a view's SQL changes. Sections 5.7 and 19.3 still only fit if the hashed definition is the normalised structure, with view and function bodies judged by a scratch reprint. Confirms the P03 finding. The spec was not edited. |
| plpgsql body dependencies        | missing capability | `task_rows` reads `tasks`. With no declared edge, `DROP TABLE` succeeds, the function remains, and `select task_rows()` fails with `tasks` missing. `pg_depend` still has no edge. A declared edge makes the plan drop the function first.                                |
| Ambiguous-rename scan            | bug                | Fixed in this spike. 200-table diff was 819 ms, then 5.96 ms.                                                                                                                                                                                                             |
| Quoted integer partition bounds  | DX                 | Unchanged from P03. The parser strips quotes before comparing. List, hash, and timestamptz bounds needed their own normalised spellings.                                                                                                                                  |
| SQL function lock versus plpgsql | DX                 | `LANGUAGE sql` takes `AccessShareLock` on the tables it reads. plpgsql takes none. The plan has to say which.                                                                                                                                                             |
| Trigger left for `DROP TABLE`    | bug                | Fixed in this spike. Recreating `tasks` dropped `touch()` while `tasks_touch` still called it. Seed 8 failed with `cannot drop function touch() because other objects depend on it`. The trigger is dropped first.                                                        |

No property pair failed after those fixes. No performance problem remains at the 200-table fixture.

## Measurements

Diff and plan add one nullable column to every table. Scratch times are apply plus introspect of the fixture, not including planning. The 500-case property time is every pair applied twice (the plan, and B on a fresh schema), including policies, materialized views, sequences, and extensions. One machine. Not a budget.

| Measurement                               | Result           |
| ----------------------------------------- | ---------------- |
| Diff, 10 tables, 91 objects               | 0.51 ms          |
| Plan, 10 tables, 10 steps                 | 1.67 ms          |
| Diff, 50 tables, 388 objects              | 2.03 ms          |
| Plan, 50 tables, 50 steps                 | 5.72 ms          |
| Diff, 200 tables, 1558 objects            | 5.96 ms          |
| Plan, 200 tables, 200 steps               | 20.96 ms         |
| Scratch apply, 10 tables                  | 14.34 ms         |
| Scratch introspect, 10 tables             | 5.77 ms          |
| Scratch apply, 50 tables                  | 54.10 ms         |
| Scratch introspect, 50 tables             | 5.60 ms          |
| Scratch apply, 200 tables                 | 201.93 ms        |
| Scratch introspect, 200 tables            | 9.37 ms          |
| Property cases, `bun run check`           | 100              |
| Property failures, check run              | 0                |
| Property wall time, check run             | 2964 ms          |
| Property cases, `OKM_MIGRATION_CASES=500` | 500              |
| Property failures, 500-case run           | 0                |
| Property wall time, 500-case run          | 13967 ms         |
| Expression scratch cases                  | 8 classes, 63 ms |

The scratch round trip is dominated by apply. Introspect stays under 10 ms at 200 tables.

## Not in this spike

Row estimates from `pg_class` (section 19.1; that display is P51). Expand/contract tags, concurrent indexes, and `NOT VALID` constraints (P50). Migration history, `okm_meta`, and resume (P16). Extension mutations install and drop the extension; they do not change a column's type to a type that extension provides. `DROP SCHEMA` in test cleanup uses `CASCADE`. No planned statement does.
