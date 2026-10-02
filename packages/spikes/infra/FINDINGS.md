# Infra spike findings

Question: can roles, grants, extensions, and archivable tables go through the same catalog, diff, and plan as tables, without a special case?

Engine for roles, grants, archive, and the `citext` upgrade: Postgres 17 from `bun run db:up`. Extension inventory: official `postgres:15` through `postgres:18` containers, ports 55445–55448. The planner lives in the private package `@okmodel/spikes`. Nothing here is published. The spec was not edited.

## What worked on the shared machinery

- A role, a grant, and a default privilege use the same envelope as a table: kind, identity, owner, definition, dependencies, provenance. `diffCatalog` pairs them by identity. A grant that depends on its role and its table is created after both. Revoke is the drop. Round trip on Postgres 17 matched: two roles, `GRANT SELECT` on the table, and `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES`.
- `owner: "external"` already meant "do not emit DDL". An external role is not created and not dropped. Grants on that role still plan and apply. A role created outside the plan, then marked external in the before catalog, round-trips. Marking the same role `managed` while it is absent from the before catalog emits `CREATE ROLE`, and Postgres rejects it with `42710` (`duplicate_object`).
- A column-strategy archive table is an ordinary table. Archived rows are rows. The four migrations are the existing column and constraint plans: add `rank int4 not null default 0`, narrow `score` from `int8` to `int4`, add `UNIQUE (sku)`, rename `title` to `name`. After all four, the archived and active counts were unchanged, archived rows had `rank = 0`, and the renamed column was readable. The partial unique index (`WHERE archived_at IS NULL`) was still there.
- Restore after those migrations is SQL on the same table. Restoring an archived `shared@x` while an active row holds that email fails with `23505` on `tasks_email_active`. `restore` by `archive_id` clears `archived_at` and `archive_id` on the parent and the child that share that id, and leaves a child archived earlier under a different id.
- `citext` installed at version `1.4` plans as `ALTER EXTENSION citext UPDATE TO '1.6'`. Postgres 17 applied it. `extversion` became `1.6`. Moving `citext` with `SET SCHEMA` succeeded. `pg_depend` deptype `e` found 47 functions, 2 types, and 26 operators in the extension schema. Introspection of user functions returned none of those 47.
- Diff of 50 roles and 1000 grants is the same identity diff as a table diff. Introspection of that catalog matched.

## What had to be a special case

- **Role changes are `ALTER ROLE`, not drop and create.** The generic "definition changed, so drop and recreate" path would `DROP ROLE`. That fails once the role has a grant, and it is cluster-wide. Login and inherit go through `ALTER ROLE`.
- **Extension version and schema are `ALTER EXTENSION`, not drop and create.** Dropping `citext` to change its version would drop the types it owns. The plan emits `UPDATE TO` and `SET SCHEMA`.
- **`external` also suppresses alter.** A matched role or extension is altered only when both sides are `managed`. Switching a role from `external` to `managed` emits nothing: the role is already there, and the owner bit is not in the snapshot the diff compares.
- **Grant identity is not a Postgres identifier.** Spec section 5.7 names a grant as `(role, object, privilege)`. That string is longer than 63 bytes once the role name is long. `assertCatalog` does not apply the identifier limit to grants or default privileges. Role names still have the limit.
- **`aclexplode` returns the owner's privileges too.** The round trip keeps a row only when the grantee is a role in the catalog. Otherwise every new table looks like a pile of extra grants for the table owner.
- **Extension functions are filtered with `pg_depend` deptype `e`.** Without that filter they are ordinary rows in `pg_proc` and the user-object diff would create them. The filter is on function introspection. Types and operators are not catalog kinds in this spike, so they never enter the diff. They are omitted, not stored as `external`.
- **A partial index predicate is part of the index.** The index definition gained `predicate`. A rename of a column the predicate names is a dependent recreate, which is the existing column path once the predicate is visible to it. A unique constraint cannot carry `WHERE`. The archive unique is an index, not a constraint.
- **`GRANT`, `REVOKE`, `CREATE ROLE`, and `ALTER EXTENSION` are not table locks.** The lock helper's fallback calls any other statement `AccessExclusiveLock`. These statements take no user-relation lock. Inside an open transaction, `GRANT INSERT` on the table showed `AccessShareLock` on `pg_class` and no lock on the table.

## What the spec says that this machinery does not do

- **Update paths are checked at apply, not at plan time.** Section 4.1 says a version raise checks `pg_extension_update_paths` while planning, and a lower version is refused (`OKM1814`). The planner emits `ALTER EXTENSION … UPDATE TO` with no server attached. Postgres 17 then accepts `1.4` → `1.6` (`1.4--1.5--1.6`) and rejects `1.6` → `999` with `22023` (`no update path`). Every path from installed `1.6` back to `1.4`, `1.5`, `1.3`, `1.2`, `1.1`, or `1.0` is empty. The planner does not raise `OKM1814`.
- **A non-relocatable extension is also rejected by the server.** `plpgsql` has `extrelocatable = false`. `ALTER EXTENSION plpgsql SET SCHEMA public` fails with `0A000` (`does not support SET SCHEMA`). The plan still emits the statement. The relocatable flag is on `pg_available_extension_versions`, not on the offline catalog, unless the author copies it in.
- **Roles are cluster-wide. The catalog is per database.** `pg_roles` in a second database sees a role created in the first. `DROP ROLE` from the first fails with `2BP01` while the second database still has a grant: `1 object in database d_…`. The before catalog of one database cannot see that dependency. There is no `CREATE ROLE IF NOT EXISTS`. A managed role that already exists fails with `42710` unless introspection put it in the before catalog as `external`.
- **`CREATEROLE` is the gate, not "superuser".** The topology user `okm` is a superuser (`rolsuper` true, `rolcreaterole` true). A login that is `NOSUPERUSER CREATEROLE` can `CREATE ROLE`. A login that is `NOSUPERUSER NOCREATEROLE` gets `42501` (`permission denied to create role`). The plan is the same `CREATE ROLE` either way. A managed service that does not grant `CREATEROLE` cannot apply a managed role. The plan does not know that until apply.
- **Default privileges follow the creating role, not the catalog.** `ALTER DEFAULT PRIVILEGES FOR ROLE mig … GRANT SELECT ON TABLES TO app` grants `SELECT` on a table created after `SET ROLE mig`. The same statement does not grant it on a table created by the session user. The shared plan never emits `SET ROLE`. A new table is not reachable by the application role unless the migration session is that role.
- **The archive parent rule is not a constraint.** With the column strategy the row stays in place, so the foreign key stays valid. `UPDATE` of a child to clear `archived_at` succeeds while its parent is still archived. Section 8 says that restore fails and names the parent. Nothing in the catalog or the plan does that. Cascade by `archive_id` is an application `UPDATE`, not a dependency edge.
- **A new unique constraint sees archived rows.** Two archived rows with the same `sku` make `UNIQUE (sku)` fail with `23505` (`could not create unique index "tasks_sku_key"`). The partial index does not. Section 8 says uniques become partial. A later unique that is not written as a partial index applies to the archived half of the table.

## Extension inventory

`pg_available_extensions` joined to `pg_available_extension_versions`. Query time is one read. The default schema column is empty for `citext`: it is relocatable and has no fixed schema. Installed version is empty until `CREATE EXTENSION`. `plpgsql` is not relocatable on any of the four images.

| Major | Extensions | Query    | `citext` default | `citext` versions | Relocatable |
| ----- | ---------- | -------- | ---------------- | ----------------- | ----------- |
| 15    | 47         | 33.12 ms | 1.6              | 1.4, 1.5, 1.6     | yes         |
| 16    | 47         | 24.93 ms | 1.6              | 1.4, 1.5, 1.6     | yes         |
| 17    | 45         | 14.75 ms | 1.6              | 1.4, 1.5, 1.6     | yes         |
| 18    | 46         | 20.10 ms | 1.8              | 1.4–1.8           | yes         |

Many contrib extensions ship more than one version on a single image (`citext`, `pg_trgm`, `hstore`, `btree_gist`, and others). A declared version can disagree with the default the image would install. On Postgres 18 the default `citext` is `1.8`. A catalog that pins `1.6` is an explicit `VERSION`, not a no-op, and a downgrade from an already installed `1.8` has the same empty-path shape measured above on 17.

Starting all four containers and reading them took 5.53 s in one test. That includes process start. The query times are the column above.

## Classification

| Item                                          | Class              | Evidence                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version path checked at apply, not plan       | contradiction      | Section 4.1 checks `pg_extension_update_paths` at planning and refuses a lower version with OKM1814. The plan emits `UPDATE TO`. Postgres 17 accepts `1.4` → `1.6` and rejects `1.6` → `999` with `22023`. Paths from `1.6` to every older version are empty. The planner never raises OKM1814. |
| Extension members are omitted, not `external` | contradiction      | Section 4.1 says extension objects are recorded as `external` and never diffed. Functions are dropped by a `pg_depend` filter (47 `citext` functions, 0 leaked). Types (2) and operators (26) are not catalog kinds, so they are invisible. Nothing stores them as `external`.                  |
| `DROP ROLE` is cluster-wide                   | missing capability | Role created in database A is visible in database B. `DROP ROLE` from A fails with `2BP01`: `1 object in database d_…`. The per-database before catalog cannot see it.                                                                                                                          |
| `CREATE ROLE` has no `IF NOT EXISTS`          | missing capability | A managed role that already exists fails with `42710`. The plan does not read `pg_roles`. Marking the role `external` in the before catalog is what skips the create.                                                                                                                           |
| No `CREATEROLE`                               | missing capability | `NOSUPERUSER NOCREATEROLE` gets `42501`. `NOSUPERUSER CREATEROLE` succeeds. The plan cannot see the privilege. "Not a superuser" is not the failure.                                                                                                                                            |
| Default privileges need `SET ROLE`            | missing capability | Section 5.7 says the application role can use a new table without a manual grant. A table created by the session user did not receive the default. A table created after `SET ROLE mig` did. The plan emits no `SET ROLE`.                                                                      |
| Archive parent rule                           | missing capability | `UPDATE` cleared a child's `archived_at` while the parent was archived. The foreign key stayed valid. Section 8 says that restore fails. The catalog has no restore step.                                                                                                                       |
| Non-relocatable `SET SCHEMA`                  | missing capability | `plpgsql` is not relocatable. The plan can still emit `SET SCHEMA`. Postgres rejects it with `0A000`.                                                                                                                                                                                           |
| Grant identity longer than 63 bytes           | DX                 | `(role, object, privilege)` is the identity. It is not a name Postgres stores. The 63-byte check does not apply. Role names still do.                                                                                                                                                           |
| Full unique versus archived duplicates        | DX                 | `UNIQUE (sku)` failed with `23505` because two archived rows shared `sku`. The partial unique on `email` allowed the same value once. Section 8 says uniques become partial. A constraint that is not partial counts archived rows.                                                             |
| `GRANT` lock fallback                         | DX                 | The lock helper would have called `GRANT` an `AccessExclusiveLock` on a user table. `pg_locks` showed `AccessShareLock` on `pg_class` and no lock on the table. Role, grant, and `ALTER EXTENSION` statements are classified as no user-relation lock.                                          |

No performance problem showed up at 50 roles and 1000 grants, or at 100k archived rows. Numbers are below. No correctness bug remains in the spike after the special cases above. The spec was not edited.

## Measurements

One machine. Postgres 17 for privileges and archive. Not a budget.

Privilege scale is 50 roles, 20 tables, 1000 `SELECT` grants. Diff times are in process. Introspect and apply hit Postgres 17. "Same" diffs a catalog with itself. "One grant added" diffs a catalog missing one grant against the full catalog.

| Measurement                                      | Result    |
| ------------------------------------------------ | --------- |
| Diff, 1000 grants, same catalog                  | 5.24 ms   |
| Diff, 1000 grants, one grant added               | 4.69 ms   |
| Apply, 50 roles and 1000 grants                  | 324.15 ms |
| Introspect those roles and grants                | 2.75 ms   |
| Diff introspected privileges against the catalog | 5.17 ms   |

Archive migration time is plan plus apply. Half the rows are archived. Counts after the four steps matched the insert: 5,000 / 5,000 and 50,000 / 50,000.

| Step                               | 10k rows | 100k rows |
| ---------------------------------- | -------- | --------- |
| Add `NOT NULL` column with default | 2.05 ms  | 1.52 ms   |
| Change `int8` to `int4`            | 15.10 ms | 88.48 ms  |
| Add unique constraint              | 13.67 ms | 107.65 ms |
| Rename column                      | 1.05 ms  | 3.08 ms   |

The constant default does not rewrite the table: 100k was not slower than 10k. The type change and the unique constraint grow with the row count. Rename stays a catalog update. Archived rows are in the same heap, so they are not a second migration.

## Not in this spike

Row-level security as the application role (the spec's "roles and grants" pass condition also names RLS; that is not required to answer whether grants use the same diff). Passwords and `GRANT` option beyond a boolean on the object. Schema-level default privileges (`defaclobjtype = n`). Operators and base types as catalog kinds. A planner that reads `pg_roles`, `pg_extension_update_paths`, or `rolcreaterole` before it emits SQL. `SET ROLE` inside the plan. The archive parent rule as a database constraint. Table-strategy archive.
