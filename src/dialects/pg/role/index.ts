/**
 * Role and grant records for `defineConfig({ roles })`.
 *
 * `schema()` does not import this module. Tooling calls {@link attachRoles}.
 * Role creation is `okm roles apply`, not a migration. Default privileges are
 * not emitted.
 */

import { catalog } from "../../../contracts/catalog/build.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import { grantObject, roleObject } from "../../../contracts/catalog/privilege.js";
import { functionObject } from "../../../contracts/catalog/routine.js";
import type {
  Catalog,
  CatalogObject,
  GrantObjectRef,
  ObjectIdentity,
  Provenance,
} from "../../../contracts/catalog/types.js";
import { OkmError } from "../../../contracts/error.js";
import { quoteIdent } from "../ddl.js";
import { type RolesInput, normalizeRoles } from "./config.js";
import { readGrants } from "./grant-slot.js";
import { expandGrants, type GrantWarning } from "./grants.js";
import { columnPrivilege } from "./sql.js";

export type { RoleEntry, RoleMembership, RolesInput } from "./config.js";
export type { GrantWarning } from "./grants.js";

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

const PROVENANCE: Provenance = { origin: "file", name: "roles" };

const RELATION = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const READ = ["SELECT"] as const;
const ROUTINE = ["EXECUTE"] as const;
const SEQUENCE = ["USAGE", "SELECT"] as const;

/**
 * Adds role, grant, and default-privilege objects to a catalog.
 *
 * Objects without `grants` keep the baseline: `app` receives DML, execute, and
 * sequence usage; `reporting` receives select. An object with `grants` uses
 * that option as the truth for managed roles. Role rows are external, so the
 * plan does not create them.
 *
 * @param source - Catalog from `schema()`
 * @param input - Migration role, application role, and any custom roles
 * @param exposure - Hidden columns. Omitted when no table hides one
 * @param tableGrants - SQL table name to the table's `grants` option
 * @returns A catalog that includes those objects
 */
export function attachRoles(
  source: Catalog,
  input: RolesInput,
  exposure?: readonly TableExposure[],
  tableGrants?: ReadonlyMap<string, unknown>,
  floor?: number,
): Catalog {
  const contributed = contributeRoles(input, source.objects, exposure, tableGrants, floor);
  return catalog([...source.objects, ...contributed.objects]);
}

/**
 * Warnings from the last {@link contributeRoles} call in this turn.
 *
 * The catalog function returns objects. Warnings travel beside it.
 */
/**
 * Warnings for the same arguments as {@link attachRoles}.
 *
 * @param input - Roles config
 * @param objects - Catalog objects
 * @param exposure - Hidden columns
 * @param tableGrants - SQL table name to the table's `grants` option
 * @returns Warnings. Errors throw
 */
export function explainRoles(
  input: RolesInput,
  objects: readonly CatalogObject[],
  exposure?: readonly TableExposure[],
  tableGrants?: ReadonlyMap<string, unknown>,
  floor?: number,
): readonly GrantWarning[] {
  return contributeRoles(input, objects, exposure, tableGrants, floor).warnings;
}

type Contributed = {
  readonly objects: readonly CatalogObject[];
  readonly warnings: readonly GrantWarning[];
};

/**
 * Catalog records for one `roles` configuration.
 *
 * @param input - Roles config
 * @param built - Objects already in the catalog
 * @param exposure - Hidden columns
 * @param tableGrants - SQL table name to the table's `grants` option
 * @returns Role and grant records, and warnings
 */
export function contributeRoles(
  input: RolesInput,
  built: readonly CatalogObject[],
  exposure?: readonly TableExposure[],
  tableGrants?: ReadonlyMap<string, unknown>,
  floor?: number,
): Contributed {
  const roles = normalizeRoles(input);
  const app = roles.find((entry) => entry.key === "app");
  const reporting = roles.find((entry) => entry.key === "reporting");
  if (app === undefined || roles.some((entry) => entry.key === "migration") === false) {
    throw new OkmError("OKM1910", "roles needs migration and app.", {
      fix: { summary: "Set roles.migration and roles.app." },
    });
  }
  const objects: CatalogObject[] = [];
  const warnings: GrantWarning[] = [];
  for (const entry of [...roles].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    objects.push(
      roleObject({
        name: entry.name,
        owner: "external",
        provenance: PROVENANCE,
        login: entry.env !== undefined,
        inherit: true,
      }),
    );
  }
  const roleIdentity = (name: string): ObjectIdentity => ({ kind: "role", name });
  const namespaces = new Set<string>();
  const exposed = indexExposure(exposure);
  const columnGrants = new Map<string, PendingColumnGrant>();
  const declared = new Set<string>();
  for (const object of built) {
    if (object.owner === "ignored" || object.owner === "external") continue;
    const ref = grantRef(object);
    if (ref === undefined) continue;
    const namespace = ref.namespace.form === "static" ? ref.namespace.name : "public";
    namespaces.add(namespace);
    const option = objectGrants(object, namespace, tableGrants);
    if (option !== undefined) {
      declared.add(objectKey(object));
      const expanded = expandGrants(option, ref.kind, roles, objectLabel(object));
      warnings.push(...expanded.warnings);
      if (object.kind === "view" && object.definition.securityInvoker === true) {
        warnings.push({
          summary: `${objectLabel(object)} is an invoker view. ${app.name} needs the base privilege on the underlying tables.`,
        });
      }
      for (const grant of expanded.grants) {
        objects.push(
          grantObject({
            role: grant.role,
            object: ref,
            privilege: grant.privilege,
            provenance: PROVENANCE,
            dependencies: [
              roleIdentity(grant.role === "public" ? app.name : grant.role),
              objectIdentity(object),
            ],
          }),
        );
      }
      continue;
    }
    for (const privilege of privilegesFor(ref.kind)) {
      objects.push(
        grantObject({
          role: app.name,
          object: ref,
          privilege,
          provenance: PROVENANCE,
          dependencies: [roleIdentity(app.name), objectIdentity(object)],
        }),
      );
    }
  }
  const relations = built.filter(
    (object) =>
      object.owner !== "ignored" &&
      object.owner !== "external" &&
      (object.kind === "table" || object.kind === "view" || object.kind === "materializedView") &&
      !declared.has(objectKey(object)),
  );
  const schemas = namespaces.size === 0 ? ["public"] : [...namespaces].sort();
  for (const name of schemas) {
    const namespace = staticNamespace(name);
    const schemaGrants = readGrants("namespace", name, name);
    if (schemaGrants !== undefined) {
      const expanded = expandGrants(schemaGrants, "schema", roles, `schema ${name}`);
      warnings.push(...expanded.warnings);
      for (const grant of expanded.grants) {
        objects.push(
          grantObject({
            role: grant.role,
            object: { kind: "namespace", namespace, name },
            privilege: grant.privilege,
            provenance: PROVENANCE,
            dependencies: [roleIdentity(grant.role === "public" ? app.name : grant.role)],
          }),
        );
      }
    } else if (reporting !== undefined) {
      objects.push(
        grantObject({
          role: reporting.name,
          object: { kind: "namespace", namespace, name },
          privilege: "USAGE",
          provenance: PROVENANCE,
          dependencies: [roleIdentity(reporting.name)],
        }),
      );
    }
  }
  if (reporting !== undefined) {
    for (const object of relations) {
      const ref = grantRef(object);
      if (ref === undefined) continue;
      noteReportingSelect(columnGrants, objects, reporting.name, object, ref, exposed, built);
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
  for (const object of built) {
    if (object.kind !== "materializedView") continue;
    if (object.owner === "ignored" || object.owner === "external") continue;
    noteMatviewRefresh(objects, app.name, object, floor);
  }
  return { objects, warnings };
}

function noteMatviewRefresh(
  objects: CatalogObject[],
  app: string,
  object: CatalogObject & { readonly kind: "materializedView" },
  floor: number | undefined,
): void {
  const namespace = object.identity.namespace;
  const schema = namespace.form === "static" ? namespace.name : "public";
  const ref = grantRef(object);
  if (ref === undefined) return;
  if (floor !== undefined && floor >= 17) {
    objects.push(
      grantObject({
        role: app,
        object: ref,
        privilege: "MAINTAIN",
        provenance: PROVENANCE,
        dependencies: [{ kind: "role", name: app }, object.identity],
      }),
    );
    return;
  }
  const name = `okm_refresh_${object.identity.name}`;
  if (name.length > 63) {
    throw new OkmError("OKM1910", `Refresh function ${name} is longer than 63 bytes.`, {
      fix: { summary: "Shorten the materialized view name, or set minPostgres to 17 or newer." },
    });
  }
  const fn = functionObject({
    name,
    namespace: object.identity.namespace,
    language: "plpgsql",
    returns: "void",
    security: "definer",
    searchPath: schema,
    body: `begin refresh materialized view ${quoteIdent(object.identity.name)}; end`,
    provenance: PROVENANCE,
  });
  objects.push(fn);
  objects.push(
    grantObject({
      role: app,
      object: {
        kind: "function",
        namespace: object.identity.namespace,
        name: `${name}()`,
      },
      privilege: "EXECUTE",
      provenance: PROVENANCE,
      dependencies: [{ kind: "role", name: app }, fn.identity],
    }),
  );
}

type PendingColumnGrant = {
  readonly key: string;
  readonly role: string;
  readonly privilege: "SELECT" | "UPDATE";
  readonly object: GrantObjectRef;
  readonly target: CatalogObject;
  readonly columns: Set<string>;
};

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

function objectGrants(
  object: CatalogObject,
  namespace: string,
  tableGrants: ReadonlyMap<string, unknown> | undefined,
): unknown {
  if (object.kind === "table") return tableGrants?.get(object.identity.name);
  if (object.kind === "view" || object.kind === "materializedView") {
    return readGrants(object.kind, namespace, object.identity.name);
  }
  if (object.kind === "function") {
    return readGrants("function", namespace, object.identity.name);
  }
  return undefined;
}

function objectKey(object: CatalogObject): string {
  return `${object.kind}:${named(object)}`;
}

function objectLabel(object: CatalogObject): string {
  return `${object.kind} ${named(object)}`;
}

function named(object: CatalogObject): string {
  if (
    object.kind === "table" ||
    object.kind === "view" ||
    object.kind === "materializedView" ||
    object.kind === "function" ||
    object.kind === "sequence"
  ) {
    return object.identity.name;
  }
  return object.kind;
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
