/**
 * `roles: { migration, app, reporting? }`.
 *
 * The object contributes role, grant, and default-privilege records. `schema()`
 * does not import this module. Tooling calls {@link attachRoles} when the
 * config names roles.
 */

import { catalog } from "../../../contracts/catalog/build.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import {
  defaultPrivilegeObject,
  grantObject,
  roleObject,
} from "../../../contracts/catalog/privilege.js";
import type {
  Catalog,
  CatalogObject,
  GrantObjectRef,
  ObjectIdentity,
  Provenance,
} from "../../../contracts/catalog/types.js";
import { OkmError } from "../../../contracts/error.js";
import { columnPrivilege } from "./sql.js";

/** A role the plan creates and alters. It is never dropped. */
export type ManagedRole = {
  readonly name: string;
  /** `LOGIN` when true. The default is `NOLOGIN`. */
  readonly login?: boolean;
  /** `INHERIT` when not `false`. */
  readonly inherit?: boolean;
};

/**
 * One column grant.
 *
 * `on` is the table, view, or materialized view name. `select` and `update`
 * name columns. A hidden column is included only when it is listed here.
 */
export type ColumnGrantInput = {
  /** Role that receives the privilege. */
  readonly role: string;
  /** Table, view, or materialized view. */
  readonly on: string;
  /** Columns granted `SELECT`. */
  readonly select?: readonly string[];
  /** Columns granted `UPDATE`. */
  readonly update?: readonly string[];
};

/**
 * Why a `roles` declaration was refused.
 *
 * `reporting_distinct` means the reporting role is the migration or
 * application role. `reporting_write` means that role was granted a write.
 */
export type RoleDeclarationReason = "reporting_distinct" | "reporting_write";

/**
 * A `roles` declaration this version refuses.
 *
 * The kind stays `invalid`. No new OKM code: OKM1825 is a missing privilege
 * at doctor time, and OKM1060 is a column definition.
 */
export class RoleDeclarationError extends OkmError {
  /** Which rule refused the declaration. */
  readonly reason: RoleDeclarationReason;

  /**
   * @param reason - Which rule failed
   * @param message - What the author should change
   */
  constructor(reason: RoleDeclarationReason, message: string) {
    super("invalid", message, {
      kind: "invalid",
      fix: {
        summary:
          reason === "reporting_write"
            ? "Grant select, or use the application role for writes."
            : "Give the reporting role its own name.",
      },
    });
    this.name = "OkmError";
    this.reason = reason;
  }
}

/**
 * Columns of one table, for the reporting role's hidden-column rule.
 *
 * `hidden` is true for `.hidden()` and for `hidden({ filterable: true })`.
 */
export type TableExposure = {
  /** SQL table name. */
  readonly table: string;
  /** Field name and SQL name. `hidden` is left out of the reporting role. */
  readonly columns: readonly {
    readonly field: string;
    readonly sql: string;
    readonly hidden: boolean;
  }[];
};

/**
 * Roles named by `defineConfig`.
 *
 * A string is external: it must already exist. A name listed in `managed` is
 * created when `pg_roles` does not have it. `reporting` receives select only.
 */
export type RolesInput = {
  /** Role that runs migrations. */
  readonly migration: string;
  /** Role the application connects as. */
  readonly app: string;
  /**
   * Read-only role.
   *
   * Select on tables, views, and materialized views, usage on schemas, and
   * default privileges for later tables. No write and no execute.
   */
  readonly reporting?: string;
  /** Roles this catalog creates and alters. */
  readonly managed?: readonly ManagedRole[];
  /** Column `SELECT` or `UPDATE` grants. */
  readonly columns?: readonly ColumnGrantInput[];
};

const PROVENANCE: Provenance = { origin: "file", name: "roles" };

const RELATION = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const READ = ["SELECT"] as const;
const ROUTINE = ["EXECUTE"] as const;
const SEQUENCE = ["USAGE", "SELECT"] as const;

/**
 * Adds role, grant, and default-privilege objects to a catalog.
 *
 * Grants and default privileges are for {@link RolesInput.app} on every
 * managed table, view, materialized view, sequence, and function. Column
 * grants and the reporting role are added when `input` names them.
 *
 * @param source - Catalog from `schema()`
 * @param input - Migration role, application role, and managed roles
 * @param exposure - Hidden columns. Omitted when no table hides one
 * @returns A catalog that includes those objects
 */
export function attachRoles(
  source: Catalog,
  input: RolesInput,
  exposure?: readonly TableExposure[],
): Catalog {
  return catalog([...source.objects, ...contributeRoles(input, source.objects, exposure)]);
}

/**
 * Catalog records for one `roles` configuration.
 *
 * @param input - Migration role, application role, and managed roles
 * @param built - Objects already in the catalog
 * @param exposure - Hidden columns. Omitted when no table hides one
 * @returns Role, grant, and default-privilege records
 */
export function contributeRoles(
  input: RolesInput,
  built: readonly CatalogObject[],
  exposure?: readonly TableExposure[],
): readonly CatalogObject[] {
  const migration = requireName(input.migration, "migration");
  const app = requireName(input.app, "app");
  const reporting =
    input.reporting === undefined ? undefined : requireName(input.reporting, "reporting");
  if (reporting !== undefined && (reporting === app || reporting === migration)) {
    throw new RoleDeclarationError(
      "reporting_distinct",
      `Role ${reporting} cannot be the reporting role and also migration or app.`,
    );
  }
  const managed = new Map<string, ManagedRole>();
  for (const role of input.managed ?? []) {
    const name = requireName(role.name, "managed role");
    managed.set(name, role);
  }
  const objects: CatalogObject[] = [];
  const names = new Set<string>([migration, app, ...managed.keys()]);
  if (reporting !== undefined) names.add(reporting);
  for (const grant of input.columns ?? []) names.add(requireName(grant.role, "column grant role"));
  for (const name of [...names].sort()) {
    const declaration = managed.get(name);
    objects.push(
      roleObject({
        name,
        owner: declaration === undefined ? "external" : "managed",
        provenance: PROVENANCE,
        ...(declaration === undefined
          ? { login: false, inherit: true }
          : {
              ...(declaration.login !== undefined ? { login: declaration.login } : {}),
              ...(declaration.inherit !== undefined ? { inherit: declaration.inherit } : {}),
            }),
      }),
    );
  }
  const roleIdentity = (name: string): ObjectIdentity => ({ kind: "role", name });
  const namespaces = new Set<string>();
  const exposed = indexExposure(exposure);
  const columnGrants = new Map<string, PendingColumnGrant>();
  for (const object of built) {
    if (object.owner === "ignored" || object.owner === "external") continue;
    const ref = grantRef(object);
    if (ref === undefined) continue;
    if (ref.namespace.form === "static") namespaces.add(ref.namespace.name);
    const privileges = privilegesFor(ref.kind);
    for (const privilege of privileges) {
      objects.push(
        grantObject({
          role: app,
          object: ref,
          privilege,
          provenance: PROVENANCE,
          dependencies: [roleIdentity(app), objectIdentity(object)],
        }),
      );
    }
  }
  const relations = built.filter(
    (object) =>
      object.owner !== "ignored" &&
      object.owner !== "external" &&
      (object.kind === "table" || object.kind === "view" || object.kind === "materializedView"),
  );
  const schemas = namespaces.size === 0 ? ["public"] : [...namespaces].sort();
  for (const name of schemas) {
    const namespace = staticNamespace(name);
    for (const [objectKind, privileges] of [
      ["table", RELATION],
      ["function", ROUTINE],
      ["sequence", SEQUENCE],
    ] as const) {
      for (const privilege of privileges) {
        objects.push(
          defaultPrivilegeObject({
            forRole: migration,
            namespace,
            objectKind,
            grantee: app,
            privilege,
            provenance: PROVENANCE,
            dependencies: [roleIdentity(migration), roleIdentity(app)],
          }),
        );
      }
    }
    if (reporting !== undefined) {
      objects.push(
        grantObject({
          role: reporting,
          object: { kind: "namespace", namespace, name },
          privilege: "USAGE",
          provenance: PROVENANCE,
          dependencies: [roleIdentity(reporting)],
        }),
      );
      objects.push(
        defaultPrivilegeObject({
          forRole: migration,
          namespace,
          objectKind: "table",
          grantee: reporting,
          privilege: "SELECT",
          provenance: PROVENANCE,
          dependencies: [roleIdentity(migration), roleIdentity(reporting)],
        }),
      );
    }
  }
  for (const grant of input.columns ?? []) {
    noteColumnGrant(columnGrants, grant, built, exposed, reporting);
  }
  if (reporting !== undefined) {
    for (const object of relations) {
      const ref = grantRef(object);
      if (ref === undefined) continue;
      noteReportingSelect(columnGrants, objects, reporting, object, ref, exposed, built);
    }
  }
  for (const pending of [...columnGrants.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  )) {
    const target = pending.target;
    objects.push(
      grantObject({
        role: pending.role,
        object: pending.object,
        privilege: columnPrivilege(pending.privilege, [...pending.columns].sort()),
        provenance: PROVENANCE,
        dependencies: [roleIdentity(pending.role), target.identity],
      }),
    );
  }
  return objects;
}

type PendingColumnGrant = {
  readonly key: string;
  readonly role: string;
  readonly privilege: "SELECT" | "UPDATE";
  readonly object: GrantObjectRef;
  readonly target: CatalogObject;
  readonly columns: Set<string>;
};

function requireName(name: string, role: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new OkmError("invalid", `roles.${role} needs a name.`, {
      fix: { summary: "Set roles.migration and roles.app to role names." },
    });
  }
  return name;
}

function grantRef(object: CatalogObject): GrantObjectRef | undefined {
  if (object.kind === "table" || object.kind === "view" || object.kind === "materializedView") {
    return { kind: object.kind, namespace: object.identity.namespace, name: object.identity.name };
  }
  if (object.kind === "sequence") {
    return { kind: "sequence", namespace: object.identity.namespace, name: object.identity.name };
  }
  if (object.kind === "function") {
    return {
      kind: "function",
      namespace: object.identity.namespace,
      name: `${object.identity.name}(${object.identity.argTypes.join(",")})`,
    };
  }
  return undefined;
}

function privilegesFor(kind: GrantObjectRef["kind"]): readonly string[] {
  if (kind === "function") return ROUTINE;
  if (kind === "sequence") return SEQUENCE;
  if (kind === "materializedView") return READ;
  if (kind === "namespace") return [];
  return RELATION;
}

function objectIdentity(object: CatalogObject): ObjectIdentity {
  return object.identity;
}

function indexExposure(
  exposure: readonly TableExposure[] | undefined,
): ReadonlyMap<string, TableExposure> {
  const indexed = new Map<string, TableExposure>();
  for (const table of exposure ?? []) indexed.set(table.table, table);
  return indexed;
}

function noteReportingSelect(
  pending: Map<string, PendingColumnGrant>,
  objects: CatalogObject[],
  role: string,
  target: CatalogObject,
  ref: GrantObjectRef,
  exposed: ReadonlyMap<string, TableExposure>,
  built: readonly CatalogObject[],
): void {
  const key = columnKey(role, ref, "SELECT");
  const declared = pending.get(key);
  if (ref.kind === "view" || ref.kind === "materializedView") {
    if (declared !== undefined) return;
    objects.push(selectGrant(role, ref, target));
    return;
  }
  const visible = visibleColumns(ref.name, exposed, built);
  const hidden = hiddenColumns(ref.name, exposed);
  if (hidden.size === 0) {
    pending.delete(key);
    objects.push(selectGrant(role, ref, target));
    return;
  }
  const columns = new Set<string>(visible);
  for (const name of declared?.columns ?? []) columns.add(name);
  if (columns.size === 0) {
    pending.delete(key);
    return;
  }
  const next = declared ?? openColumnGrant(role, ref, "SELECT", target);
  next.columns.clear();
  for (const name of columns) next.columns.add(name);
  pending.set(key, next);
}

function selectGrant(role: string, ref: GrantObjectRef, target: CatalogObject): CatalogObject {
  return grantObject({
    role,
    object: ref,
    privilege: "SELECT",
    provenance: PROVENANCE,
    dependencies: [{ kind: "role", name: role }, target.identity],
  });
}

function noteColumnGrant(
  pending: Map<string, PendingColumnGrant>,
  grant: ColumnGrantInput,
  built: readonly CatalogObject[],
  exposed: ReadonlyMap<string, TableExposure>,
  reporting: string | undefined,
): void {
  const role = requireName(grant.role, "column grant role");
  const target = findRelation(built, grant.on);
  if (target.owner === "ignored") {
    throw new OkmError("invalid", `Column grant on ${grant.on} targets an ignored table.`, {
      fix: { summary: "Remove the grant, or mark the table external." },
    });
  }
  const ref = grantRef(target);
  if (ref === undefined) {
    throw new OkmError("OKM1020", `Column grant on ${grant.on} is not a table or a view.`, {
      fix: { summary: "Name a table, view, or materialized view in the schema." },
    });
  }
  for (const privilege of ["select", "update"] as const) {
    const names = grant[privilege];
    if (names === undefined || names.length === 0) continue;
    if (role === reporting && privilege === "update") {
      throw new RoleDeclarationError(
        "reporting_write",
        `Role ${role} is the reporting role and cannot be granted update.`,
      );
    }
    const upper = privilege === "select" ? "SELECT" : "UPDATE";
    const resolved = names.map((name) => resolveColumn(target, built, ref.name, name, exposed));
    const current =
      pending.get(columnKey(role, ref, upper)) ?? openColumnGrant(role, ref, upper, target);
    for (const name of resolved) current.columns.add(name);
    pending.set(current.key, current);
  }
}

function openColumnGrant(
  role: string,
  object: GrantObjectRef,
  privilege: "SELECT" | "UPDATE",
  target: CatalogObject,
): PendingColumnGrant {
  return {
    key: columnKey(role, object, privilege),
    role,
    privilege,
    object,
    target,
    columns: new Set(),
  };
}

function columnKey(role: string, object: GrantObjectRef, privilege: string): string {
  const namespace =
    object.namespace.form === "static" ? object.namespace.name : object.namespace.pattern;
  return `${role}\0${object.kind}\0${namespace}\0${object.name}\0${privilege}`;
}

function findRelation(built: readonly CatalogObject[], name: string): CatalogObject {
  const found = built.filter(
    (object) =>
      (object.kind === "table" || object.kind === "view" || object.kind === "materializedView") &&
      object.identity.name === name,
  );
  const target = found[0];
  if (target === undefined) {
    throw new OkmError("OKM1020", `Column grant names ${name}, which is not in the schema.`, {
      fix: { summary: "Use the SQL name of a table, view, or materialized view." },
    });
  }
  if (found.length > 1) {
    throw new OkmError("OKM1020", `Column grant on ${name} matches more than one object.`, {
      fix: { summary: "Rename one of the objects so the grant names one." },
    });
  }
  return target;
}

function resolveColumn(
  target: CatalogObject,
  built: readonly CatalogObject[],
  table: string,
  name: string,
  exposed: ReadonlyMap<string, TableExposure>,
): string {
  const known = exposed.get(table);
  const fromField = known?.columns.find((column) => column.field === name || column.sql === name);
  if (fromField !== undefined) return fromField.sql;
  const sqlNames = columnNames(target, built, table);
  if (sqlNames.includes(name)) return name;
  throw new OkmError("OKM1020", `Column ${table}.${name} is not in the schema.`, {
    fix: { summary: "Name a column of that table or view." },
  });
}

function visibleColumns(
  table: string,
  exposed: ReadonlyMap<string, TableExposure>,
  built: readonly CatalogObject[],
): readonly string[] {
  const known = exposed.get(table);
  if (known !== undefined) {
    return known.columns.filter((column) => !column.hidden).map((column) => column.sql);
  }
  return built.flatMap((object) =>
    object.kind === "column" && object.identity.parent.name === table ? [object.identity.name] : [],
  );
}

function hiddenColumns(
  table: string,
  exposed: ReadonlyMap<string, TableExposure>,
): ReadonlySet<string> {
  const known = exposed.get(table);
  return new Set(
    (known?.columns ?? []).filter((column) => column.hidden).map((column) => column.sql),
  );
}

function columnNames(
  target: CatalogObject,
  built: readonly CatalogObject[],
  table: string,
): string[] {
  if (target.kind === "view" || target.kind === "materializedView") {
    return target.definition.columns.map((column) => column.name);
  }
  return built.flatMap((object) =>
    object.kind === "column" && object.identity.parent.name === table ? [object.identity.name] : [],
  );
}
