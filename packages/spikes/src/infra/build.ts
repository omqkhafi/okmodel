/**
 * Catalog objects for roles, grants, default privileges, and archivable tables.
 *
 * They use the same envelope as every other kind. Identity is the only part
 * that does not fit a namespace plus a name.
 */

import {
  defaultPrivilegeIdentityName,
  grantIdentityName,
  staticNamespace,
  type CatalogObject,
  type ColumnObject,
  type ConstraintObject,
  type DefaultPrivilegeObject,
  type DependencyEdge,
  type GrantObject,
  type GrantObjectKind,
  type GrantPrivilege,
  type IndexObject,
  type NamespaceName,
  type ObjectIdentity,
  type Owner,
  type Provenance,
  type RoleObject,
  type TableObject,
} from "../catalog/object.js";
import { type ColumnRename } from "../migrations/diff.js";

const provenance: Provenance = { source: "infra" };

/**
 * One step of the archive migration sequence.
 */
export type ArchiveStep = {
  readonly label: string;
  readonly before: readonly CatalogObject[];
  readonly after: readonly CatalogObject[];
  readonly renames: readonly ColumnRename[];
};

/**
 * A managed or external role.
 *
 * @param name - Role name
 * @param owner - `managed` when this catalog creates it
 * @param login - Whether the role can log in
 * @returns A role object
 */
export function role(name: string, owner: Owner, login: boolean): RoleObject {
  return {
    kind: "role",
    identity: { kind: "role", name },
    owner,
    definition: { login, inherit: true },
    dependencies: [],
    provenance,
  };
}

/**
 * A grant on a table, sequence, or schema.
 *
 * @param namespace - Schema the object lives in
 * @param parent - Relation name. Empty for a schema grant
 * @param objectKind - What `parent` names
 * @param grantee - Role that receives the privilege
 * @param privilege - Privilege keyword
 * @param edges - Role and, for a relation, the relation
 * @returns A grant object
 */
export function grant(
  namespace: NamespaceName,
  parent: string,
  objectKind: GrantObjectKind,
  grantee: string,
  privilege: GrantPrivilege,
  edges: readonly ObjectIdentity[],
): GrantObject {
  return {
    kind: "grant",
    identity: {
      kind: "grant",
      namespace,
      parent,
      name: grantIdentityName(grantee, objectKind, privilege),
      role: grantee,
      objectKind,
      privilege,
    },
    owner: "managed",
    definition: { grantable: false },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

/**
 * One default privilege.
 *
 * @param namespace - Schema named by `IN SCHEMA`
 * @param forRole - Role whose future objects are affected
 * @param grantee - Role that receives the privilege
 * @param privilege - Privilege keyword
 * @param edges - Both roles
 * @returns A default-privilege object
 */
export function defaultPrivilege(
  namespace: NamespaceName,
  forRole: string,
  grantee: string,
  privilege: GrantPrivilege,
  edges: readonly ObjectIdentity[],
): DefaultPrivilegeObject {
  return {
    kind: "default_privilege",
    identity: {
      kind: "default_privilege",
      namespace,
      name: defaultPrivilegeIdentityName(forRole, "tables", grantee, privilege),
      forRole,
      role: grantee,
      objectType: "tables",
      privilege,
    },
    owner: "managed",
    definition: { grantable: false },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

/**
 * Roles, one table, explicit grants, and default privileges for a round trip.
 *
 * @param namespace - Schema the table lives in
 * @param migrationRole - Role that owns future tables
 * @param appRole - Role that receives `SELECT`
 * @param migrationOwner - Ownership of the migration role
 * @param appOwner - Ownership of the application role
 * @returns A catalog the shared planner can apply
 */
export function privilegeRoundTrip(
  namespace: NamespaceName,
  migrationRole: string,
  appRole: string,
  migrationOwner: Owner = "managed",
  appOwner: Owner = "managed",
): readonly CatalogObject[] {
  const migration = role(migrationRole, migrationOwner, false);
  const app = role(appRole, appOwner, false);
  const tasks = table(namespace, "tasks");
  const id = column(namespace, "tasks", "id", "int8", false, [tasks.identity]);
  const key = primaryKey(namespace, "tasks", "tasks_pkey", ["id"], [tasks.identity]);
  const onTable = grant(namespace, "tasks", "table", appRole, "select", [
    app.identity,
    tasks.identity,
  ]);
  const future = defaultPrivilege(namespace, migrationRole, appRole, "select", [
    migration.identity,
    app.identity,
  ]);
  return [migration, app, tasks, id, key, onTable, future];
}

/**
 * Fifty roles and one thousand table grants, plus the tables those grants need.
 *
 * 50 roles × 20 tables × `SELECT` is 1000 grants.
 *
 * @param namespace - Schema the tables live in
 * @param prefix - Prefix for generated role and table names
 * @returns The scale catalog
 */
export function privilegeScale(namespace: NamespaceName, prefix: string): readonly CatalogObject[] {
  const objects: CatalogObject[] = [];
  const roles: RoleObject[] = [];
  for (let index = 0; index < 50; index += 1) {
    const created = role(`${prefix}_r${String(index).padStart(2, "0")}`, "managed", false);
    roles.push(created);
    objects.push(created);
  }
  for (let tableIndex = 0; tableIndex < 20; tableIndex += 1) {
    const name = `${prefix}_t${String(tableIndex).padStart(2, "0")}`;
    const created = table(namespace, name);
    const id = column(namespace, name, "id", "int8", false, [created.identity]);
    objects.push(created, id);
    for (const createdRole of roles) {
      objects.push(
        grant(namespace, name, "table", createdRole.identity.name, "select", [
          createdRole.identity,
          created.identity,
        ]),
      );
    }
  }
  return objects;
}

/**
 * Four migrations over an archivable table.
 *
 * The partial unique index is `WHERE archived_at IS NULL`. The steps add a
 * `NOT NULL` column with a default, narrow `score` from `int8` to `int4`, add
 * a unique constraint, and rename `title` to `name`.
 *
 * @param namespace - Schema the tables live in
 * @param withChild - Include `reminders` so cascade restore has a child table
 * @returns Steps in apply order
 */
export function archiveSteps(namespace: NamespaceName, withChild: boolean): readonly ArchiveStep[] {
  const base = archiveCatalog(namespace, withChild, {
    scoreType: "int8",
    rank: false,
    uniqueSku: false,
    title: "title",
  });
  const ranked = archiveCatalog(namespace, withChild, {
    scoreType: "int8",
    rank: true,
    uniqueSku: false,
    title: "title",
  });
  const narrowed = archiveCatalog(namespace, withChild, {
    scoreType: "int4",
    rank: true,
    uniqueSku: false,
    title: "title",
  });
  const unique = archiveCatalog(namespace, withChild, {
    scoreType: "int4",
    rank: true,
    uniqueSku: true,
    title: "title",
  });
  const renamed = archiveCatalog(namespace, withChild, {
    scoreType: "int4",
    rank: true,
    uniqueSku: true,
    title: "name",
  });
  const renames: readonly ColumnRename[] = [
    { namespace: namespace.name, parent: "tasks", from: "title", to: "name" },
  ];
  return [
    { label: "add-not-null-default", before: base, after: ranked, renames: [] },
    { label: "change-type", before: ranked, after: narrowed, renames: [] },
    { label: "add-unique", before: narrowed, after: unique, renames: [] },
    { label: "rename-column", before: unique, after: renamed, renames },
  ];
}

/**
 * A catalog whose partial unique index mentions `archived_at`.
 *
 * Used to see whether a rename of that column recreates the index.
 *
 * @param namespace - Schema
 * @param columnName - Column the predicate names
 * @returns Table, columns, and the partial unique index
 */
export function partialIndexCatalog(
  namespace: NamespaceName,
  columnName: string,
): readonly CatalogObject[] {
  const tasks = table(namespace, "tasks");
  const id = column(namespace, "tasks", "id", "int8", false, [tasks.identity]);
  const email = column(namespace, "tasks", "email", "text", false, [tasks.identity]);
  const archived = column(namespace, "tasks", columnName, "timestamptz", true, [tasks.identity]);
  const index = partialUnique(namespace, "tasks", "tasks_email_active", ["email"], columnName, [
    tasks.identity,
  ]);
  return [tasks, id, email, archived, index];
}

function archiveCatalog(
  namespace: NamespaceName,
  withChild: boolean,
  shape: {
    readonly scoreType: "int8" | "int4";
    readonly rank: boolean;
    readonly uniqueSku: boolean;
    readonly title: "title" | "name";
  },
): readonly CatalogObject[] {
  const tasks = table(namespace, "tasks");
  const taskEdge: DependencyEdge = { identity: tasks.identity };
  const columns = [
    column(namespace, "tasks", "id", "int8", false, [tasks.identity]),
    column(namespace, "tasks", "email", "text", false, [tasks.identity]),
    column(namespace, "tasks", shape.title, "text", false, [tasks.identity]),
    column(namespace, "tasks", "score", shape.scoreType, false, [tasks.identity], "0"),
    column(namespace, "tasks", "sku", "text", false, [tasks.identity]),
    column(namespace, "tasks", "archived_at", "timestamptz", true, [tasks.identity]),
    column(namespace, "tasks", "archive_id", "uuid", true, [tasks.identity]),
  ];
  if (shape.rank) {
    columns.push(column(namespace, "tasks", "rank", "int4", false, [tasks.identity], "0"));
  }
  const objects: CatalogObject[] = [
    tasks,
    ...columns,
    primaryKey(namespace, "tasks", "tasks_pkey", ["id"], [tasks.identity]),
    partialUnique(namespace, "tasks", "tasks_email_active", ["email"], "archived_at", [
      tasks.identity,
    ]),
  ];
  if (shape.uniqueSku) {
    objects.push(unique(namespace, "tasks", "tasks_sku_key", ["sku"], [tasks.identity]));
  }
  if (!withChild) return objects;
  const reminders = table(namespace, "reminders");
  objects.push(
    reminders,
    column(namespace, "reminders", "id", "int8", false, [reminders.identity]),
    column(namespace, "reminders", "task_id", "int8", false, [reminders.identity]),
    column(namespace, "reminders", "archived_at", "timestamptz", true, [reminders.identity]),
    column(namespace, "reminders", "archive_id", "uuid", true, [reminders.identity]),
    primaryKey(namespace, "reminders", "reminders_pkey", ["id"], [reminders.identity]),
    foreignKey(
      namespace,
      "reminders",
      "reminders_task_fkey",
      ["task_id"],
      "tasks",
      ["id"],
      [reminders.identity, taskEdge.identity],
    ),
  );
  return objects;
}

function table(namespace: NamespaceName, name: string): TableObject {
  return {
    kind: "table",
    identity: { kind: "table", namespace, name },
    owner: "managed",
    definition: { rowSecurity: false },
    dependencies: [],
    provenance,
  };
}

function column(
  namespace: NamespaceName,
  parent: string,
  name: string,
  type: string,
  nullable: boolean,
  edges: readonly ObjectIdentity[],
  defaultSql?: string,
): ColumnObject {
  return {
    kind: "column",
    identity: { kind: "column", namespace, parent, name },
    owner: "managed",
    definition: {
      type,
      nullable,
      ...(defaultSql === undefined ? {} : { defaultSql }),
    },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

function primaryKey(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  edges: readonly ObjectIdentity[],
): ConstraintObject {
  return {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent, name },
    owner: "managed",
    definition: {
      constraintKind: "primary_key",
      columns,
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

function unique(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  edges: readonly ObjectIdentity[],
): ConstraintObject {
  return {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent, name },
    owner: "managed",
    definition: {
      constraintKind: "unique",
      columns,
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

function foreignKey(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  tableName: string,
  references: readonly string[],
  edges: readonly ObjectIdentity[],
): ConstraintObject {
  return {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent, name },
    owner: "managed",
    definition: {
      constraintKind: "foreign_key",
      columns,
      references: { table: tableName, columns: references },
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

function partialUnique(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  predicateColumn: string,
  edges: readonly ObjectIdentity[],
): IndexObject {
  return {
    kind: "index",
    identity: { kind: "index", namespace, parent, name },
    owner: "managed",
    definition: {
      columns,
      unique: true,
      predicate: `${predicateColumn} is null`,
    },
    dependencies: edges.map((identity) => ({ identity })),
    provenance,
  };
}

/**
 * A static namespace used by tests that do not care which schema it is.
 *
 * @returns The namespace `app`
 */
export function appNamespace(): NamespaceName {
  return staticNamespace("app");
}
