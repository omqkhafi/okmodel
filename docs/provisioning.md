# Provisioning

An empty target installs the head snapshot. It does not replay migration files (D99, D198).

A target is empty when it has no `okm_meta`, `okm_history`, or `okm_backfill`, and its namespace has no other table, view, sequence, enum, domain, or extension. `okm migrate apply` on that target plans the last catalog from an empty catalog, inserts `reference` rows, and writes one history row, `provisioned@<migration id>`. The catalog hash is the head hash. No expand, backfill, or contract step runs.

A target that already has one of those history tables is tracked. Apply continues with files that are still pending. It does not install the snapshot again.

A target that is not empty and has no history is OKM1851. The fix is to provision an empty schema or an empty database.

Provision on an empty protected target is allowed without `--allow-protected`. A protected target that is not empty is still OKM1851.

## What the snapshot stores

Each migration has a sibling catalog file. That file is the catalog after the migration. It is not a copy of the SQL. The latest catalog is the head snapshot. Installing it plans that catalog from empty, so grants and roles are included, and a table created in that plan keeps the plain statements.

## Reference rows

Rows the application needs to exist are a table option. They live on the schema. They are not copied into the catalog, and they do not change the catalog hash.

```ts
const roles = table(
  "roles",
  { code: t.text().primaryKey(), label: t.text() },
  {
    reference: {
      key: "code",
      rows: [
        { code: "admin", label: "Admin" },
        { code: "member", label: "Member" },
      ],
    },
  },
);
```

`key` is one column, or several in order. It must be the primary key, a unique constraint, or a unique index. Each value is a string, a finite number, a boolean, or null.

Provisioning and every `okm migrate apply` insert a row when its key is missing. They never update and they never delete. Changing a label leaves the stored row. Removing a row from the declaration leaves it in the database. Adding a key inserts it on the next apply, with no DDL migration.

The statements are insert-if-missing. They are not migration steps, so OKM1542 does not see them. OKM1542 still flags `insert`, `update`, `delete`, `merge`, and `truncate` in a migration file outside a backfill step.

## `provision(target)`

`provision` from `okmodel/migrate` provisions one configured target. `default` is the `database` target. It uses the same emptiness rule and the same policy call as `okm migrate apply`.

Creating a schema per tenant, creating a database per tenant, and a tenant registry are M5.

## Equivalence

`okm migrate check` still replays the history. It does not provision.

`okm migrate check --provision` also installs the head snapshot into a second scratch schema and compares the two. Type names are normalised first. A difference is OKM1521 and names the object. Both scratch schemas are dropped, including after a failure. A protected target is refused, and `--allow-protected` does not apply. Point the command at a throwaway Postgres.
