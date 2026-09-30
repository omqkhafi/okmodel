# Catalog spike findings

Question: can one object contract describe every Postgres object kind in this spike, and can that catalog round-trip through a scratch database?

The contract is one envelope (`kind`, `identity`, `owner`, `definition`, `dependencies`, `provenance`). Identity and definition stay kind-specific. A partitioned table is a `table` plus `partition` children, not a second contract.

Engines: PGlite (reports `server_version` 18.3) and Postgres 17 from `bun run db:up`.

## What worked

- The same envelope holds table, column, index, constraint, sequence, extension, view, materialized view, function, trigger, policy, domain, and partition.
- Function identity `(namespace, name, argTypes[])` keeps `slug(text)` and `slug(int8)` distinct.
- Namespace templates (`tenant_{id}`) stay in the catalog hash. Apply resolves them; introspection maps the concrete schema back with an explicit binding.
- Canonical JSON plus SHA-256 is stable across key order, object order, and process runs. Seed-1 fixture hashes are locked in `measure.test.ts`.
- Create order is a deterministic topological sort. Drop order is its reverse. A view statement fails if it runs before its table. Dropping `tasks` while `active_tasks` exists fails. Dropping in drop order, without `CASCADE`, succeeds.
- Changing `tasks.title` plans a drop and recreate of `active_tasks` and `task_titles` only. Changing `tasks.id` leaves `task_titles` alone.
- `DEFERRABLE INITIALLY DEFERRED` and `UNIQUE NULLS NOT DISTINCT` round-trip.
- `CREATE OR REPLACE` works for the view and fails for the materialized view (`syntax error at or near "materialized"`).
- `pg_depend` shows `active_tasks` depending on columns `id` and `title`, and `tasks_touch` depending on `touch`.
- A `LANGUAGE sql` function with `BEGIN ATOMIC` that reads `tasks` gets a `pg_depend` edge to that table.
- Names longer than 63 bytes collapse under Postgres truncation (the second `CREATE` fails). A hash suffix keeps the two names distinct on both engines.
- The 10-table fixture round-trips. The 50-table and 200-table fixtures hash. Introspection of the 200-table fixture returns the same object count the catalog built (1558).

## What broke

- PGlite's `pg_constraint` has no `connullsnotdistinct` column, even though the server reports 18.3, accepts `UNIQUE NULLS NOT DISTINCT`, and `pg_get_constraintdef` prints it. Reading that column aborts introspection.
- `CREATE EXTENSION citext` fails on PGlite: `extension "citext" is not available`. The same statement succeeds on Postgres 17 in a throwaway database.
- An extension cannot be isolated in the scratch schema from P02. `CREATE EXTENSION` is database-scoped. The Postgres test creates and drops a database.
- `touch()` is plpgsql and mentions `tasks`. `pg_depend` has no edge from that function to the table. The catalog edge is declared, not discovered.
- Partition children receive a copy of the parent primary key (`events_low_pkey`). Partition indexes also show up in `pg_inherits`. Treating every `pg_inherits` row as a partition, or every constraint as authored, makes the round trip report extras.
- `pg_get_expr` quotes integer partition bounds: `FOR VALUES FROM ('0') TO ('100')`. The authored bound is `0:100`.

## What the contract needs to change

- Keep one envelope. Do not flatten identity into one struct: an extension has no namespace, and a function's identity includes argument types. Section 5.7 already lists those keys. The spike confirms the envelope, not a single identity shape.
- Split authoring text from the drift canonical form. Section 5.7 hashes the canonical definition. Section 19.3 says rewritten expressions are not compared as text. Those agree only if the hashed form is the normalised structure (columns, types, signature, flags, `pg_depend` edges), and `sql` / function body / check text stay authoring input.
- Keep declared `dependsOn` for plpgsql. `pg_depend` will not reconstruct it. `BEGIN ATOMIC` SQL functions can be inferred.
- Do not ask the author to declare the primary key and indexes Postgres copies onto each partition. Introspection has to drop those.
- Fit identifiers to 63 bytes before they are stored. Postgres truncates and collides; the catalog name is the fitted name.
- Apply extensions to a database. A schema-scoped scratch target cannot represent them.
- Leave `owner` and `provenance` on the authoring side. Postgres does not store them, so a structural round trip cannot return them.

## Classification

| Item                                                  | Class              | Evidence                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift hash versus source SQL                          | contradiction      | View and function bodies are rewritten. Equality uses columns, signature, and `pg_depend`, not the source text. Sections 5.7 and 19.3 only fit together if the hashed definition is the normalised structure. |
| `pg_constraint.connullsnotdistinct` missing on PGlite | missing capability | `server_version` 18.3, column absent, `pg_get_constraintdef` still returns `UNIQUE NULLS NOT DISTINCT (email)`.                                                                                               |
| `citext` cannot be installed on PGlite                | missing capability | `extension "citext" is not available`. Postgres 17 installs it in a scratch database.                                                                                                                         |
| Extensions are not schema-scoped                      | missing capability | Scratch-schema isolation from P02 cannot hold an extension. The Postgres test uses a throwaway database.                                                                                                      |
| plpgsql body dependencies                             | missing capability | `touch()` references `tasks` and `pg_depend` count is 0. `task_count()` (`BEGIN ATOMIC`) count is greater than 0.                                                                                             |
| Copied partition keys and inherited indexes           | DX                 | Round trip reported `events_low_pkey` and index rows in `pg_inherits` until those automatic objects were ignored.                                                                                             |
| Quoted integer partition bounds                       | DX                 | Database text is `FOR VALUES FROM ('0') TO ('100')` for authored bounds `0` and `100`.                                                                                                                        |

No performance problem showed up at the 200-table fixture. Numbers are below.

## Measurements

Hash is SHA-256 of the canonical catalog. `meanMs` is 20 repetitions. Introspection time is one read of the 200-table fixture after apply, not including apply. Object count is 1558 (tables, columns, primary keys, foreign keys, indexes).

| Measurement                        | Result                     |
| ---------------------------------- | -------------------------- |
| Hash, 10 tables, 91 objects        | 0.38 ms once, 0.25 ms mean |
| Hash, 50 tables, 388 objects       | 1.74 ms once, 1.12 ms mean |
| Hash, 200 tables, 1558 objects     | 4.45 ms once, 4.49 ms mean |
| Apply 200 tables, PGlite           | 135.45 ms                  |
| Introspect 200 tables, PGlite      | 14.33 ms                   |
| Apply 200 tables, Postgres 17      | 209.79 ms                  |
| Introspect 200 tables, Postgres 17 | 9.75 ms                    |

These are wall times from one `bun run check` on this machine, not a budget.

## Round trip

| Kind              | Postgres 17 | PGlite | Notes                                                                                                                 |
| ----------------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| table             | pass        | pass   | Includes a partitioned parent                                                                                         |
| column            | pass        | pass   | Includes `int8` default `0` and a domain type                                                                         |
| index             | pass        | pass   |                                                                                                                       |
| constraint        | pass        | pass   | Primary key, check, `NULLS NOT DISTINCT`, deferrable foreign key. PGlite needs the definition text for the nulls flag |
| sequence          | pass        | pass   |                                                                                                                       |
| extension         | pass        | fail   | `citext` is not available on PGlite. Postgres uses a throwaway database                                               |
| view              | pass        | pass   | Columns and `pg_depend`, not source SQL                                                                               |
| materialized view | pass        | pass   | `WITH NO DATA`. `CREATE OR REPLACE` fails on both                                                                     |
| function          | pass        | pass   | Overloads. Body text is not compared                                                                                  |
| trigger           | pass        | pass   | `pg_depend` edge to the function                                                                                      |
| policy            | pass        | pass   |                                                                                                                       |
| domain            | pass        | pass   | Base type and nullability. No domain `CHECK` in the sample                                                            |
| partition         | pass        | pass   | Bounds compared after stripping quotes. Copied child primary keys ignored                                             |

## Not in this spike

Grants, procedures, aggregates, operators, casts, event triggers, and foreign tables. List and hash partitioning. `SECURITY DEFINER` and `search_path`. Domain `CHECK` text. Timestamptz partition bounds. A migration planner that emits the drop/alter/recreate steps (the order and the recreate set are tested; SQL for the alter is not).
