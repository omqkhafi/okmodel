/**
 * Reads a Postgres schema into a catalog.
 *
 * Copied partition primary keys and inherited indexes are not objects: a
 * relation that is a child in `pg_inherits` is skipped, and so is an index
 * that is itself inherited (M0-06). Expressions come back from `pg_get_expr`
 * and `pg_get_constraintdef`, which is the database's normalised text (D128).
 */

import { catalog } from "../../contracts/catalog/build.js";
import { OkmError } from "../../contracts/error.js";
import { domainType, enumType } from "../../contracts/catalog/enum.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import { extensionObject } from "../../contracts/catalog/extension.js";
import { column, constraint, index, sequence, table } from "../../contracts/catalog/object.js";
import { policyObject } from "../../contracts/catalog/policy.js";
import {
  defaultPrivilegeObject,
  grantObject,
  roleObject,
} from "../../contracts/catalog/privilege.js";
import { functionObject, triggerObject } from "../../contracts/catalog/routine.js";
import {
  materializedViewIndex,
  materializedViewObject,
  normaliseViewQuery,
  viewObject,
} from "../../contracts/catalog/view.js";
import { VIEW_DEPENDENCIES, viewDependencyEdges } from "./view/depend.js";
import { quoteIdent, typeRef } from "./ddl.js";
import { quoteLiteral } from "./quote.js";
import { withUnvalidatedNotNull } from "../../contracts/catalog/not-null.js";
import { unvalidatedNotNullSql } from "./not-null.js";
import { columnPrivilege } from "./role/sql.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  FunctionVolatility,
  ObjectIdentity,
  ObjectRef,
  Provenance,
  ReferentialAction,
  TriggerEvent,
  TriggerTiming,
} from "../../contracts/catalog/types.js";
import { referentialAction } from "../../contracts/catalog/types.js";

/** Which cluster roles the catalog owns. */
export type IntrospectOptions = {
  /**
   * Role names this catalog creates and alters.
   *
   * When omitted, roles, grants, and default privileges are not read.
   */
  readonly managedRoles?: readonly string[];
  /**
   * Read-only role.
   *
   * Schema `USAGE` is read for this role only. Other roles keep the schema
   * privileges they already have.
   */
  readonly reportingRole?: string;
  /**
   * Extensions installed in another schema whose types this schema uses.
   *
   * Each is read as an extension row, with the schema it is really installed
   * in. `okm migrate check` passes the extensions it replays without moving.
   */
  readonly hostedExtensions?: readonly string[];
};

/** A connection that can run one query. Parameters are `$1`, `$2`, … */
export type CatalogQuery = {
  /**
   * Runs one query.
   *
   * @param text - SQL
   * @param params - Bound parameters
   * @returns Rows as objects keyed by the select aliases
   */
  query(text: string, params?: readonly string[]): Promise<readonly Record<string, unknown>[]>;
};

const PROVENANCE_NAME = "database";

/**
 * Introspects one concrete schema.
 *
 * Identities use `logical`, not the concrete schema name, so two scratch
 * schemas compare. The default logical namespace is `public`.
 *
 * @param runner - Database connection
 * @param concrete - Schema to read
 * @param logical - Namespace stored on the catalog identities
 * @returns A checked catalog
 */
export async function introspectSchema(
  runner: CatalogQuery,
  concrete: string,
  logical = "public",
  options?: IntrospectOptions,
): Promise<Catalog> {
  const namespace = staticNamespace(logical);
  const provenance: Provenance = { origin: "file", name: PROVENANCE_NAME };
  const params = [concrete];
  const [
    tables,
    columns,
    constraints,
    indexes,
    sequences,
    enums,
    domains,
    extensions,
    functions,
    triggers,
    functionDeps,
    views,
    viewDeps,
    policies,
  ] = await Promise.all([
    runner.query(TABLES, params),
    runner.query(COLUMNS, params),
    runner.query(CONSTRAINTS, params),
    runner.query(INDEXES, params),
    runner.query(SEQUENCES, params),
    runner.query(ENUMS, params),
    runner.query(DOMAINS, params),
    runner.query(EXTENSIONS, [concrete, JSON.stringify(options?.hostedExtensions ?? [])]),
    runner.query(FUNCTIONS, params),
    runner.query(TRIGGERS, params),
    runner.query(FUNCTION_DEPS, params),
    runner.query(VIEWS, params),
    runner.query(VIEW_DEPENDENCIES, params),
    runner.query(POLICIES, params),
  ]);
  const objects: CatalogObject[] = [];
  const parents = new Map<string, ObjectRef>();
  for (const row of tables) {
    const name = text(row, "name");
    const parent: ObjectRef = { namespace, name };
    parents.set(name, parent);
    const method = partitionMethod(text(row, "partstrat"));
    const partColumns = list(text(row, "partcols"));
    objects.push(
      table({
        namespace,
        name,
        provenance,
        ...(method === undefined || partColumns.length === 0
          ? {}
          : { partition: { method, columns: partColumns } }),
      }),
    );
  }
  const sequenceIdentity = new Map<string, ObjectIdentity>();
  for (const row of sequences) {
    const name = text(row, "name");
    const dataType = sequenceType(text(row, "type"));
    const ownedTable = text(row, "owned_table");
    const dependencies: ObjectIdentity[] = [];
    if (ownedTable.length > 0) {
      dependencies.push({ kind: "table", namespace, name: ownedTable });
    }
    const built = sequence({
      namespace,
      name,
      dataType,
      start: numberText(row, "start"),
      increment: numberText(row, "increment"),
      cycle: flag(row, "cycle"),
      provenance,
      ...(dependencies.length > 0 ? { dependencies } : {}),
    });
    sequenceIdentity.set(name, built.identity);
    objects.push(built);
  }
  const enumLabels = new Map<string, string[]>();
  for (const row of enums) {
    const name = text(row, "name");
    const labels = enumLabels.get(name) ?? [];
    labels.push(text(row, "label"));
    enumLabels.set(name, labels);
  }
  for (const [name, labels] of enumLabels) {
    objects.push(enumType({ namespace, name, labels, provenance }));
  }
  const domainNames = new Set<string>();
  const domainChecks = new Map<string, { base: string; checks: string[] }>();
  for (const row of domains) {
    const name = text(row, "name");
    const found = domainChecks.get(name) ?? { base: text(row, "base"), checks: [] };
    const expression = checkExpression(text(row, "definition"));
    if (expression.length > 0) found.checks.push(expression);
    domainChecks.set(name, found);
  }
  for (const [name, domain] of domainChecks) {
    const check = domain.checks.join(" and ");
    if (check.length === 0) continue;
    domainNames.add(name);
    objects.push(domainType({ namespace, name, base: domain.base, check, provenance }));
  }
  for (const row of columns) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    const identity = text(row, "identity");
    const generated = text(row, "generated") === "s";
    const expression = text(row, "expression");
    const collation = text(row, "collation");
    const sequenceName = text(row, "sequence");
    const dataType = text(row, "type");
    const extra: ObjectIdentity[] = [];
    const extensionName = text(row, "extension");
    if (extensionName.length > 0) extra.push({ kind: "extension", name: extensionName });
    const owned = sequenceIdentity.get(sequenceName);
    if (owned !== undefined) extra.push(owned);
    if (enumLabels.has(dataType) || domainNames.has(dataType)) {
      extra.push({ kind: "type", namespace, name: dataType });
    }
    const notNull = flag(row, "not_null");
    const unvalidated = notNull ? text(row, "not_null_unvalidated") : "";
    const built: ColumnObject = column({
      parent,
      name: text(row, "name"),
      dataType,
      nullable: !notNull,
      provenance,
      ...(extra.length > 0 ? { dependencies: extra } : {}),
      ...(identity === "a" || identity === "d" ? { identity: { always: identity === "a" } } : {}),
      ...(generated ? { generated: { stored: true, expression } } : {}),
      ...(!generated && identity !== "a" && identity !== "d" && expression.length > 0
        ? { defaultExpression: expression }
        : {}),
      ...(collation.length > 0 ? { collation } : {}),
    });
    objects.push(unvalidated.length > 0 ? withUnvalidatedNotNull(built, unvalidated) : built);
  }
  for (const row of constraints) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    const kind = constraintKind(text(row, "contype"));
    const columns = list(text(row, "columns"));
    const name = text(row, "name");
    const expression = kind === "check" ? checkExpression(text(row, "definition")) : "";
    const refTable = text(row, "ref_table");
    const refColumns = list(text(row, "ref_columns"));
    const definition = text(row, "definition");
    const onDelete = actionAfter(definition, "delete");
    const onUpdate = actionAfter(definition, "update");
    objects.push(
      constraint({
        parent,
        constraintKind: kind,
        name,
        nameKey: constraintNameKey(kind, parentName, name, columns),
        columns,
        provenance,
        deferrable: flag(row, "deferrable"),
        initially: flag(row, "deferred") ? "deferred" : "immediate",
        nullsNotDistinct: /nulls not distinct/i.test(definition),
        ...(expression.length > 0 ? { expression } : {}),
        ...(refTable.length > 0
          ? {
              references: {
                parent: {
                  namespace: referencedNamespace(text(row, "ref_schema"), concrete, namespace),
                  name: refTable,
                },
                columns: refColumns,
                ...(onDelete !== undefined ? { onDelete } : {}),
                ...(onUpdate !== undefined ? { onUpdate } : {}),
              },
            }
          : {}),
      }),
    );
  }
  const matviewNames = new Set(
    views.filter((row) => text(row, "kind") === "m").map((row) => text(row, "name")),
  );
  for (const row of indexes) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    if (matviewNames.has(parentName)) {
      const columns = list(text(row, "columns"));
      const predicate = text(row, "predicate");
      const expression = indexExpression(row, columns);
      objects.push(
        materializedViewIndex({
          parent,
          name: text(row, "name"),
          columns,
          unique: flag(row, "is_unique"),
          provenance,
          ...(expression.length > 0 ? { expression } : {}),
          ...(predicate.length > 0 ? { predicate } : {}),
        }),
      );
      continue;
    }
    const columns = list(text(row, "columns"));
    const predicate = text(row, "predicate");
    const expression = indexExpression(row, columns);
    objects.push(
      index({
        parent,
        name: text(row, "name"),
        nameKey: columns.length > 0 ? columns.join("_") : "expr",
        columns,
        unique: flag(row, "is_unique"),
        provenance,
        ...(expression.length > 0 ? { expression } : {}),
        ...(predicate.length > 0 ? { predicate } : {}),
      }),
    );
  }
  for (const row of extensions) {
    const name = text(row, "name");
    const version = text(row, "version");
    objects.push(
      extensionObject({
        name,
        schema: text(row, "schema"),
        relocatable: flag(row, "relocatable"),
        ...(version.length > 0 ? { version } : {}),
        provenance: { origin: "extension", name },
      }),
    );
  }
  const atomicEdges = new Map<string, ObjectIdentity[]>();
  for (const row of functionDeps) {
    const key = `${text(row, "name")}(${text(row, "arg_types")})`;
    const edges = atomicEdges.get(key) ?? [];
    const tableName = text(row, "table");
    const columnName = text(row, "column");
    if (columnName.length > 0) {
      edges.push({
        kind: "column",
        parent: { namespace, name: tableName },
        name: columnName,
      });
    } else if (tableName.length > 0) {
      edges.push({ kind: "table", namespace, name: tableName });
    }
    atomicEdges.set(key, edges);
  }
  for (const row of functions) {
    const name = text(row, "name");
    const language = text(row, "language") === "sql" ? "sql" : "plpgsql";
    const argTypes = splitTypes(text(row, "arg_types"));
    const source = text(row, "body");
    const atomic = language === "sql" && source.length === 0;
    const body = atomic ? atomicBody(text(row, "definition")) : source;
    const searchPath = searchPathOf(text(row, "config"));
    const key = `${name}(${text(row, "arg_types")})`;
    objects.push(
      functionObject({
        namespace,
        name,
        arguments: argumentList(row.arg_names, argTypes),
        returns: text(row, "returns"),
        language,
        volatility: volatilityOf(text(row, "volatility")),
        security: flag(row, "security") ? "definer" : "invoker",
        body,
        ...(searchPath !== undefined ? { searchPath } : {}),
        ...(atomic ? { atomic: true } : {}),
        provenance,
        ...(atomic ? { dependencies: atomicEdges.get(key) ?? [] } : {}),
      }),
    );
  }
  for (const row of triggers) {
    const bits = Number(text(row, "tgtype"));
    const updateOf = list(text(row, "update_of"));
    const when = unwrapTriggerWhen(text(row, "predicate"));
    const argTypes = splitTypes(text(row, "arg_types"));
    objects.push(
      triggerObject({
        parent: { namespace, name: text(row, "parent") },
        name: text(row, "name"),
        timing: triggerTiming(bits),
        events: triggerEvents(bits),
        level: (bits & 1) === 1 ? "row" : "statement",
        calls: {
          namespace: referencedNamespace(text(row, "function_schema"), concrete, namespace),
          name: text(row, "function"),
          argTypes,
        },
        ...(updateOf.length > 0 ? { updateOf } : {}),
        ...(when.length > 0 ? { when } : {}),
        provenance,
      }),
    );
  }
  for (const row of views) {
    const kind = text(row, "kind") === "m" ? "materializedView" : "view";
    const columns = printedColumns(text(row, "columns"));
    const query = normaliseViewQuery(text(row, "query"));
    const name = text(row, "name");
    const invoker = kind === "view" && securityInvokerOption(text(row, "options"));
    if (kind === "materializedView") {
      objects.push(materializedViewObject({ namespace, name, columns, query, provenance }));
    } else {
      objects.push(
        viewObject({
          namespace,
          name,
          columns,
          query,
          provenance,
          ...(invoker ? { securityInvoker: true as const } : {}),
        }),
      );
    }
  }
  for (const row of policies) {
    const parentName = text(row, "table_name");
    const parent = parents.get(parentName);
    if (parent === undefined) continue;
    const command = policyCommand(text(row, "command"));
    if (command === undefined || text(row, "enabled") !== "true") continue;
    objects.push(
      policyObject({
        parent,
        name: text(row, "name"),
        command,
        expression: text(row, "using_expr"),
        force: text(row, "force") === "true",
        provenance,
        dependencies: [{ kind: "table", namespace, name: parentName }],
      }),
    );
  }
  const viewEdges = viewDependencyEdges(viewDeps, namespace, objects);
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (object === undefined) continue;
    if (object.kind !== "view" && object.kind !== "materializedView") continue;
    const dependencies = viewEdges.get(object.identity.name);
    if (dependencies === undefined || dependencies.length === 0) continue;
    objects[index] =
      object.kind === "view"
        ? viewObject({
            namespace,
            name: object.identity.name,
            columns: object.definition.columns,
            query: object.definition.query,
            provenance,
            dependencies,
            ...(object.definition.securityInvoker === true
              ? { securityInvoker: true as const }
              : {}),
          })
        : materializedViewObject({
            namespace,
            name: object.identity.name,
            columns: object.definition.columns,
            query: object.definition.query,
            provenance,
            dependencies,
          });
  }
  if (options?.managedRoles !== undefined) {
    objects.push(
      ...(await readPrivileges(
        runner,
        concrete,
        logical,
        namespace,
        provenance,
        objects,
        options.managedRoles,
        options.reportingRole,
      )),
    );
  }
  await includeOutsideReferences(runner, logical, provenance, objects);
  return catalog(objects);
}

/**
 * Adds a foreign-key target that lives in another schema.
 *
 * Introspection reads one schema. A target in that schema is already in
 * `objects` under `logical`. `catalog()` still requires a target that lives
 * elsewhere, and its columns. The stored catalog marks those objects external,
 * so a plan does not emit DDL for them.
 */
async function includeOutsideReferences(
  runner: CatalogQuery,
  logical: string,
  provenance: Provenance,
  objects: CatalogObject[],
): Promise<void> {
  const wanted = new Map<string, { readonly schema: string; readonly name: string }>();
  for (const object of objects) {
    if (object.kind !== "constraint" || object.definition.references === undefined) continue;
    const parent = object.definition.references.parent;
    if (parent.namespace.form !== "static" || parent.namespace.name === logical) continue;
    wanted.set(`${parent.namespace.name}.${parent.name}`, {
      schema: parent.namespace.name,
      name: parent.name,
    });
  }
  for (const target of wanted.values()) {
    const namespace = staticNamespace(target.schema);
    const parent = { namespace, name: target.name };
    objects.push(table({ namespace, name: target.name, provenance }));
    const rows = await runner.query(OUTSIDE_COLUMNS, [target.schema, target.name]);
    for (const row of rows) {
      const notNull = flag(row, "not_null");
      const unvalidated = notNull ? text(row, "not_null_unvalidated") : "";
      const outside = column({
        parent,
        name: text(row, "name"),
        dataType: text(row, "type"),
        nullable: !notNull,
        provenance,
      });
      objects.push(unvalidated.length > 0 ? withUnvalidatedNotNull(outside, unvalidated) : outside);
    }
  }
}

const EMITTED = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE", "USAGE"]);

const ROLES = `select rolname, rolcanlogin, rolinherit from pg_roles where rolname !~ '^pg_'`;

const RELATION_GRANTS = `select c.relname as name,
  case c.relkind when 'v' then 'view' when 'm' then 'materializedView' when 'S' then 'sequence' else 'table' end as kind,
  r.rolname as role, a.privilege_type as privilege
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) as a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = $1
    and c.relkind in ('r', 'p', 'v', 'm', 'S')
    and c.relacl is not null
    and a.grantee <> 0
    and a.grantee <> c.relowner
    and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
    )`;

/**
 * A function's argument types as a grant names them, for `pg_proc p`.
 *
 * Types only, comma-separated, no spaces. Argument names are left out.
 */
export const FUNCTION_ARG_TYPES = "replace(oidvectortypes(p.proargtypes), ' ', '')";

const FUNCTION_GRANTS = `select p.proname as name,
  ${FUNCTION_ARG_TYPES} as args,
  r.rolname as role, a.privilege_type as privilege
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) as a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = $1
    and p.proacl is not null
    and a.grantee <> 0
    and a.grantee <> p.proowner
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )`;

const COLUMN_GRANTS = `select c.relname as name,
  case c.relkind when 'v' then 'view' when 'm' then 'materializedView' else 'table' end as kind,
  a.attname as column_name,
  r.rolname as role, x.privilege_type as privilege
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  cross join lateral aclexplode(a.attacl) as x
  join pg_roles r on r.oid = x.grantee
  where n.nspname = $1
    and c.relkind in ('r', 'p', 'v', 'm')
    and a.attacl is not null
    and x.grantee <> 0
    and x.grantee <> c.relowner`;

const SCHEMA_USAGE = `select 1 as ok
  from pg_namespace n
  cross join lateral aclexplode(n.nspacl) as a
  where n.nspname = $1
    and a.privilege_type = 'USAGE'
    and (
      a.grantee = 0
      or a.grantee = (select oid from pg_roles where rolname = $2)
    )
  limit 1`;

const DEFAULT_PRIVILEGES = `select owner_role.rolname as for_role, grantee.rolname as grantee,
  case d.defaclobjtype when 'S' then 'sequence' when 'f' then 'function' else 'table' end as object_kind,
  a.privilege_type as privilege
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  join pg_roles owner_role on owner_role.oid = d.defaclrole
  cross join lateral aclexplode(d.defaclacl) as a
  join pg_roles grantee on grantee.oid = a.grantee
  where n.nspname = $1
    and d.defaclobjtype in ('r', 'S', 'f')
    and a.grantee <> 0`;

async function readPrivileges(
  runner: CatalogQuery,
  concrete: string,
  logical: string,
  namespace: ReturnType<typeof staticNamespace>,
  provenance: Provenance,
  built: readonly CatalogObject[],
  managedRoles: readonly string[],
  reportingRole: string | undefined,
): Promise<CatalogObject[]> {
  const managed = new Set(managedRoles);
  const [roles, relations, functions, defaults, columns, usage] = await Promise.all([
    runner.query(ROLES, []),
    runner.query(RELATION_GRANTS, [concrete]),
    runner.query(FUNCTION_GRANTS, [concrete]),
    runner.query(DEFAULT_PRIVILEGES, [concrete]),
    runner.query(COLUMN_GRANTS, [concrete]),
    reportingRole === undefined
      ? Promise.resolve([])
      : runner.query(SCHEMA_USAGE, [concrete, reportingRole]),
  ]);
  const objects: CatalogObject[] = [];
  for (const row of roles) {
    const name = text(row, "rolname");
    objects.push(
      roleObject({
        name,
        login: flag(row, "rolcanlogin"),
        inherit: flag(row, "rolinherit"),
        owner: managed.has(name) ? "managed" : "external",
        provenance,
      }),
    );
  }
  for (const row of relations) {
    const kind = grantKind(text(row, "kind"));
    const name = text(row, "name");
    const privilege = text(row, "privilege").toUpperCase();
    const target = built.find((object) => privilegeTarget(object) === `${kind}:${name}`);
    if (!EMITTED.has(privilege) || target === undefined) continue;
    objects.push(
      grantObject({
        role: text(row, "role"),
        object: { kind, namespace, name },
        privilege,
        provenance,
        dependencies: [{ kind: "role", name: text(row, "role") }, target.identity],
      }),
    );
  }
  for (const row of functions) {
    const privilege = text(row, "privilege").toUpperCase();
    const name = `${text(row, "name")}(${text(row, "args")})`;
    const target = built.find((object) => privilegeTarget(object) === `function:${name}`);
    if (!EMITTED.has(privilege) || target === undefined) continue;
    objects.push(
      grantObject({
        role: text(row, "role"),
        object: { kind: "function", namespace, name },
        privilege,
        provenance,
        dependencies: [{ kind: "role", name: text(row, "role") }, target.identity],
      }),
    );
  }
  for (const row of defaults) {
    const privilege = text(row, "privilege").toUpperCase();
    if (!EMITTED.has(privilege)) continue;
    const forRole = text(row, "for_role");
    const grantee = text(row, "grantee");
    objects.push(
      defaultPrivilegeObject({
        forRole,
        namespace,
        objectKind: text(row, "object_kind"),
        grantee,
        privilege,
        provenance,
        dependencies: [
          { kind: "role", name: forRole },
          { kind: "role", name: grantee },
        ],
      }),
    );
  }
  const grouped = new Map<
    string,
    {
      role: string;
      kind: "table" | "view" | "materializedView";
      name: string;
      privilege: string;
      columns: string[];
    }
  >();
  for (const row of columns) {
    const privilege = text(row, "privilege").toUpperCase();
    if (privilege !== "SELECT" && privilege !== "UPDATE") continue;
    const kind = grantKind(text(row, "kind"));
    if (kind !== "table" && kind !== "view" && kind !== "materializedView") continue;
    const name = text(row, "name");
    const role = text(row, "role");
    const key = `${role}\0${kind}\0${name}\0${privilege}`;
    const current = grouped.get(key) ?? { role, kind, name, privilege, columns: [] };
    current.columns.push(text(row, "column_name"));
    grouped.set(key, current);
  }
  for (const group of grouped.values()) {
    const target = built.find(
      (object) => privilegeTarget(object) === `${group.kind}:${group.name}`,
    );
    if (target === undefined) continue;
    objects.push(
      grantObject({
        role: group.role,
        object: { kind: group.kind, namespace, name: group.name },
        privilege: columnPrivilege(group.privilege, group.columns),
        provenance,
        dependencies: [{ kind: "role", name: group.role }, target.identity],
      }),
    );
  }
  if (usage.length > 0 && reportingRole !== undefined) {
    objects.push(
      grantObject({
        role: reportingRole,
        object: { kind: "namespace", namespace, name: logical },
        privilege: "USAGE",
        provenance,
        dependencies: [{ kind: "role", name: reportingRole }],
      }),
    );
  }
  return objects;
}

function privilegeTarget(object: CatalogObject): string {
  if (
    object.kind === "table" ||
    object.kind === "view" ||
    object.kind === "materializedView" ||
    object.kind === "sequence"
  ) {
    return `${object.kind}:${object.identity.name}`;
  }
  if (object.kind === "function") {
    return `function:${object.identity.name}(${object.identity.argTypes.join(",")})`;
  }
  return "";
}

function grantKind(kind: string): "table" | "view" | "materializedView" | "sequence" {
  if (kind === "view" || kind === "materializedView" || kind === "sequence") return kind;
  return "table";
}

function printedColumns(value: string): { name: string; dataType: string }[] {
  if (value.length === 0) return [];
  return value.split("\n").map((line) => {
    const splitAt = line.indexOf("|");
    return {
      name: splitAt < 0 ? line : line.slice(0, splitAt),
      dataType: splitAt < 0 ? "text" : line.slice(splitAt + 1),
    };
  });
}

function argumentList(names: unknown, types: readonly string[]): { name: string; type: string }[] {
  const stored = Array.isArray(names)
    ? names.map((item) => String(item))
    : typeof names === "string" && names.startsWith("{")
      ? names
          .slice(1, -1)
          .split(",")
          .filter((item) => item.length > 0)
      : [];
  return types.map((type, index) => ({ name: stored[index] || `arg${String(index + 1)}`, type }));
}

function splitTypes(value: string): string[] {
  return value.length === 0 ? [] : value.split("|");
}

function volatilityOf(value: string): FunctionVolatility {
  if (value === "s") return "stable";
  if (value === "i") return "immutable";
  return "volatile";
}

function searchPathOf(config: string): string | undefined {
  const match = /search_path=([^,}]+)/.exec(config);
  const found = match?.[1]?.replaceAll('"', "");
  return found === undefined || found.length === 0 ? undefined : found;
}

/**
 * The `BEGIN ATOMIC` block inside `pg_get_functiondef`.
 *
 * A definition that does not contain that block is returned whole. The slice
 * stops at the last `END`, which is the block closer. A `CASE` closer earlier
 * in the reprint stays inside the block.
 *
 * @param definition - `pg_get_functiondef` text
 * @returns The body introspection stores
 */
export function atomicBody(definition: string): string {
  const start = definition.indexOf("BEGIN ATOMIC");
  if (start < 0) return definition.trim();
  const end = definition.lastIndexOf("END");
  return definition.slice(start, end < start ? undefined : end + 3).trim();
}

function triggerTiming(bits: number): TriggerTiming {
  if ((bits & 64) !== 0) return "instead";
  if ((bits & 2) !== 0) return "before";
  return "after";
}

function triggerEvents(bits: number): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  if ((bits & 4) !== 0) events.push("insert");
  if ((bits & 16) !== 0) events.push("update");
  if ((bits & 8) !== 0) events.push("delete");
  if ((bits & 32) !== 0) events.push("truncate");
  return events;
}

function indexExpression(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): string {
  const method = text(row, "am");
  const stored = text(row, "expression");
  if (method.length === 0 || method === "btree") return stored;
  const opclasses = list(text(row, "opc"));
  const body = columns
    .map((name, index) => {
      const opclass = opclasses[index];
      return opclass === undefined ? quoteIdent(name) : `${quoteIdent(name)} ${opclass}`;
    })
    .join(", ");
  return `using ${method} (${body.length > 0 ? body : stored})`;
}

/** Column shape used when {@link reprintCheck} builds a scratch table. */
export type ReprintCheckColumn = {
  readonly name: string;
  readonly dataType: string;
};

/**
 * A catalog type a scratch column may name.
 *
 * The scratch objects stand in for it when the schema does not have it yet:
 * an enum with `labels`, or a domain over `base` with no check.
 */
export type ReprintType = {
  readonly name: string;
  readonly labels?: readonly string[];
  readonly base?: string;
};

/**
 * Applies one expression as a check and reads Postgres's reprint.
 *
 * Two authoring spellings of the same predicate compare equal after this.
 * A different predicate does not. Column types matter: `IN (...)` on
 * `varchar(n)` reprints differently from the same list on `text`.
 *
 * The first reprint is not always what a later statement stores. A varchar
 * `IN` list becomes `ARRAY[...]::text[]`, and applying that text prints a
 * per-element cast instead. This repeats until the text stops changing, so
 * the result can be written into DDL and read back as the same string.
 *
 * The table is a temporary table with a random name, and so is each stand-in
 * for a type in `types` that a column names. Nothing is created in the
 * target schema, so the role needs no `CREATE` on it. Temporary objects are
 * dropped before this returns.
 *
 * @param runner - Database connection
 * @param expression - Check expression without the `CHECK` keyword
 * @param columns - Scratch columns. Defaults to `id integer` and `title text`
 * @param types - Enums and domains the columns may name, with the labels or base to rebuild
 * @returns The reprinted expression, without the `CHECK` keyword
 */
export async function reprintCheck(
  runner: CatalogQuery,
  expression: string,
  columns: readonly ReprintCheckColumn[] = [
    { name: "id", dataType: "integer" },
    { name: "title", dataType: "text" },
  ],
  types: readonly ReprintType[] = [],
): Promise<string> {
  return reprintUntilStable(expression, (current) =>
    reprintCheckOnce(runner, current, columns, types),
  );
}

async function reprintCheckOnce(
  runner: CatalogQuery,
  expression: string,
  columns: readonly ReprintCheckColumn[],
  types: readonly ReprintType[],
): Promise<string> {
  const table = scratchName("okm_expr");
  const standIns = await createStandIns(
    runner,
    columns.map((column) => column.dataType),
    types,
  );
  try {
    const defs =
      columns.length > 0
        ? columns
            .map((column) => `${quoteIdent(column.name)} ${standInType(column.dataType, types)}`)
            .join(", ")
        : "id integer";
    await runner.query(`create temp table ${table} (${defs})`);
    await runner.query(
      `alter table pg_temp.${table} add constraint okm_expr_check check (${expression})`,
    );
    const rows = await runner.query(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conrelid = $1::regclass and conname = 'okm_expr_check'`,
      [`pg_temp.${table}`],
    );
    return checkExpression(text(rows[0] ?? {}, "definition"));
  } catch (error) {
    throw readOnlyReprint(error) ?? error;
  } finally {
    await runDrops(runner, [`drop table if exists pg_temp.${table}`, ...standIns]);
  }
}

/**
 * Maps a temporary-object failure on a read-only session to OKM1896.
 *
 * A check, picklist, domain check, generated column, or btree index
 * expression is reprinted on a temporary table. A replica or a session with
 * `default_transaction_read_only` cannot create one, and neither can a role
 * without `TEMP`. Any other failure is left alone.
 *
 * @param error - Failure from the scratch statement
 * @returns OKM1896, or `undefined` when this is not that refusal
 */
export function readOnlyReprint(error: unknown): OkmError | undefined {
  const message = error instanceof Error ? error.message : "";
  if (
    !/read-only transaction/i.test(message) &&
    !/permission denied to create temporary/i.test(message)
  ) {
    return undefined;
  }
  return new OkmError(
    "OKM1896",
    "A check or picklist is reprinted on a temporary table, and this connection cannot create one.",
    {
      cause: error,
      fix: {
        summary:
          "Point the command at a writable primary. The role needs TEMP on the database. It does not need CREATE on the schema.",
      },
    },
  );
}

/**
 * What a scratch btree index reads back as.
 *
 * `expression` is `pg_get_expr(indexprs)`. `columns` are the key columns
 * (`indkey` above 0), which is empty for a pure expression. `predicate` is
 * `pg_get_expr(indpred)`, or empty when the index has none.
 */
export type ReprintedIndex = {
  readonly expression: string;
  readonly columns: readonly string[];
  readonly predicate: string;
};

/**
 * Creates a scratch btree index and reads the text Postgres stores.
 *
 * `lower( email )` reprints as `lower(email)`. A pure expression has no key
 * column, so `columns` comes back empty even when the declaration named the
 * column the expression uses. A `using` tail is not an expression Postgres
 * prints this way; pass it through unchanged.
 *
 * The table is temporary, with a random name, and so is each stand-in for a
 * type in `types`. Nothing is created in the target schema. The index is
 * created as `((expression))`, which is how a btree expression is emitted,
 * then read the way introspection reads `indexprs`.
 *
 * @param runner - Database connection
 * @param expression - Index expression, or a `using` tail
 * @param columns - Columns of the parent table, so the expression resolves
 * @param types - Enums and domains the columns may name
 * @param options - Uniqueness and the partial predicate, when the index has one
 * @returns The reprinted expression, key columns, and predicate
 */
export async function reprintIndex(
  runner: CatalogQuery,
  expression: string,
  columns: readonly ReprintCheckColumn[] = [],
  types: readonly ReprintType[] = [],
  options?: { readonly unique?: boolean; readonly predicate?: string },
): Promise<ReprintedIndex> {
  if (/^using\s/i.test(expression)) {
    return { expression, columns: [], predicate: options?.predicate ?? "" };
  }
  let printed: ReprintedIndex = {
    expression,
    columns: [],
    predicate: options?.predicate ?? "",
  };
  for (let pass = 0; pass < REPRINT_PASSES; pass += 1) {
    const next = await reprintIndexOnce(runner, printed.expression, columns, types, {
      unique: options?.unique === true,
      ...(printed.predicate.length > 0 ? { predicate: printed.predicate } : {}),
    });
    if (
      pass > 0 &&
      next.expression === printed.expression &&
      next.predicate === printed.predicate &&
      sameNames(next.columns, printed.columns)
    ) {
      return next;
    }
    printed = next;
  }
  return printed;
}

async function reprintIndexOnce(
  runner: CatalogQuery,
  expression: string,
  columns: readonly ReprintCheckColumn[],
  types: readonly ReprintType[],
  options: { readonly unique: boolean; readonly predicate?: string },
): Promise<ReprintedIndex> {
  const table = scratchName("okm_idx");
  const index = scratchName("okm_idx");
  const standIns = await createStandIns(
    runner,
    columns.map((column) => column.dataType),
    types,
  );
  try {
    const defs =
      columns.length > 0
        ? columns
            .map((column) => `${quoteIdent(column.name)} ${standInType(column.dataType, types)}`)
            .join(", ")
        : "id integer";
    await runner.query(`create temp table ${table} (${defs})`);
    const unique = options.unique ? "unique " : "";
    const where = options.predicate === undefined ? "" : ` where ${options.predicate}`;
    await runner.query(
      `create ${unique}index ${quoteIdent(index)} on pg_temp.${table} ((${expression}))${where}`,
    );
    const rows = await runner.query(
      `select pg_get_expr(i.indexprs, i.indrelid) as expression,
        coalesce(pg_get_expr(i.indpred, i.indrelid), '') as predicate,
        (
          select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
          from unnest(i.indkey) with ordinality as cols(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = cols.attnum
          where cols.attnum > 0
        ) as columns
       from pg_index i
       join pg_class idx on idx.oid = i.indexrelid
       where i.indrelid = $1::regclass and idx.relname = $2`,
      [`pg_temp.${table}`, index],
    );
    const row = rows[0] ?? {};
    return {
      expression: text(row, "expression"),
      columns: list(text(row, "columns")),
      predicate: text(row, "predicate"),
    };
  } catch (error) {
    throw readOnlyReprint(error) ?? error;
  } finally {
    await runDrops(runner, [`drop table if exists pg_temp.${table}`, ...standIns]);
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Trigger shape {@link reprintTriggerWhen} needs to build a valid scratch trigger. */
export type ReprintTrigger = {
  readonly timing: "before" | "after" | "instead";
  readonly events: readonly ("insert" | "update" | "delete" | "truncate")[];
  readonly level: "row" | "statement";
};

/**
 * Creates a scratch trigger with one `WHEN` and reads the text Postgres prints.
 *
 * The result goes through the same extraction as introspection, so keyword
 * case, `OLD` / `NEW` case, and redundant parentheses in the author's text
 * compare equal to what a live trigger reads back. The trigger sits on a
 * temporary table with a random name, calls a temporary function, and both
 * are dropped before this returns. Nothing is created in the target schema.
 *
 * @param runner - Database connection
 * @param expression - `WHEN` expression without the keyword or outer parentheses
 * @param trigger - Timing, events, and level of the trigger that carries it
 * @param columns - Columns of the table the trigger is on
 * @param types - Enums and domains the columns may name, with the labels or base to rebuild
 * @returns The reprinted expression, or `undefined` when this server refuses the scratch trigger
 */
export async function reprintTriggerWhen(
  runner: CatalogQuery,
  expression: string,
  trigger: ReprintTrigger,
  columns: readonly ReprintCheckColumn[],
  types: readonly ReprintType[] = [],
): Promise<string | undefined> {
  const table = scratchName("okm_when");
  const fn = scratchName("okm_when_fn");
  const standIns = await createStandIns(
    runner,
    columns.map((column) => column.dataType),
    types,
  );
  try {
    const defs =
      columns.length > 0
        ? columns
            .map((column) => `${quoteIdent(column.name)} ${standInType(column.dataType, types)}`)
            .join(", ")
        : "id integer";
    await runner.query(`create temp table ${table} (${defs})`);
    await runner.query(
      `create function pg_temp.${fn}() returns trigger language plpgsql as 'begin return null; end'`,
    );
    await runner.query(
      `create trigger okm_when_trigger ${trigger.timing === "instead" ? "instead of" : trigger.timing} ${trigger.events.join(" or ")} on pg_temp.${table} for each ${trigger.level} when (${expression}) execute function pg_temp.${fn}()`,
    );
    const rows = await runner.query(
      `select pg_get_triggerdef(oid) as definition
       from pg_trigger
       where tgrelid = $1::regclass and tgname = 'okm_when_trigger'`,
      [`pg_temp.${table}`],
    );
    const match = /WHEN \(([\s\S]*)\) EXECUTE/.exec(text(rows[0] ?? {}, "definition"));
    return match?.[1] === undefined ? undefined : unwrapTriggerWhen(match[1]);
  } catch (error) {
    const mapped = readOnlyReprint(error);
    if (mapped !== undefined) throw mapped;
    return undefined;
  } finally {
    await runDrops(runner, [
      `drop table if exists pg_temp.${table}`,
      `drop function if exists pg_temp.${fn}()`,
      ...standIns,
    ]);
  }
}

/**
 * Creates a temporary domain and reads the check Postgres stores.
 *
 * Domain checks use `VALUE`, which is not valid on a table check. Two
 * authoring spellings of the same domain predicate compare equal after this.
 * The reprint repeats until Postgres prints the same text, matching
 * {@link reprintCheck}. The domain and any stand-in for an enum or domain
 * `base` names are temporary objects with random names. Nothing is created
 * in the target schema.
 *
 * @param runner - Database connection
 * @param base - Domain base type, as Postgres `format_type` spells it
 * @param expression - Check expression without the `CHECK` keyword
 * @param types - Enums and domains `base` may name, with the labels or base to rebuild
 * @returns The reprinted expression, without the `CHECK` keyword
 */
export async function reprintDomainCheck(
  runner: CatalogQuery,
  base: string,
  expression: string,
  types: readonly ReprintType[] = [],
): Promise<string> {
  return reprintUntilStable(expression, (current) =>
    reprintDomainCheckOnce(runner, base, current, types),
  );
}

async function reprintDomainCheckOnce(
  runner: CatalogQuery,
  base: string,
  expression: string,
  types: readonly ReprintType[],
): Promise<string> {
  const domain = scratchName("okm_expr_domain");
  const standIns = await createStandIns(runner, [base], types);
  try {
    await runner.query(
      `create domain pg_temp.${domain} as ${standInType(base, types)} check (${expression})`,
    );
    const rows = await runner.query(
      `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       where c.contypid = $1::regtype`,
      [`pg_temp.${domain}`],
    );
    return checkExpression(text(rows[0] ?? {}, "definition"));
  } catch (error) {
    throw readOnlyReprint(error) ?? error;
  } finally {
    await runDrops(runner, [`drop domain if exists pg_temp.${domain}`, ...standIns]);
  }
}

/** Passes a scratch reprint is allowed to take before the text is treated as stable. */
const REPRINT_PASSES = 4;

/**
 * Creates a scratch generated column and reads the expression Postgres stores.
 *
 * `("a" + 1)` is printed `(a + 1)`. The reprint repeats until that text stops
 * changing, the same way {@link reprintCheck} does. Sibling columns are plain
 * columns of the same names and types, so the expression resolves. The table
 * is temporary and is dropped before this returns.
 *
 * @param runner - Database connection
 * @param expression - Generated expression, without the `GENERATED` clause
 * @param column - Name and type of the generated column
 * @param columns - Other columns of the same table. The generated column is omitted
 * @param types - Enums and domains the columns may name
 * @returns The reprinted expression
 */
export async function reprintGenerated(
  runner: CatalogQuery,
  expression: string,
  column: ReprintCheckColumn,
  columns: readonly ReprintCheckColumn[] = [],
  types: readonly ReprintType[] = [],
): Promise<string> {
  return reprintUntilStable(expression, (current) =>
    reprintGeneratedOnce(runner, current, column, columns, types),
  );
}

async function reprintGeneratedOnce(
  runner: CatalogQuery,
  expression: string,
  column: ReprintCheckColumn,
  columns: readonly ReprintCheckColumn[],
  types: readonly ReprintType[],
): Promise<string> {
  const table = scratchName("okm_expr_gen");
  const standIns = await createStandIns(
    runner,
    [column.dataType, ...columns.map((item) => item.dataType)],
    types,
  );
  try {
    const defs = [
      ...columns.map((item) => `${quoteIdent(item.name)} ${standInType(item.dataType, types)}`),
      `${quoteIdent(column.name)} ${standInType(column.dataType, types)} generated always as (${expression}) stored`,
    ].join(", ");
    await runner.query(`create temp table ${table} (${defs})`);
    const rows = await runner.query(
      `select pg_get_expr(ad.adbin, ad.adrelid) as expression
       from pg_attrdef ad
       join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
       where ad.adrelid = $1::regclass and a.attname = $2`,
      [`pg_temp.${table}`, column.name],
    );
    return flattenSqlWhitespace(text(rows[0] ?? {}, "expression"));
  } catch (error) {
    throw readOnlyReprint(error) ?? error;
  } finally {
    await runDrops(runner, [`drop table if exists pg_temp.${table}`, ...standIns]);
  }
}

async function reprintUntilStable(
  expression: string,
  reprint: (current: string) => Promise<string>,
): Promise<string> {
  let current = expression;
  for (let pass = 0; pass < REPRINT_PASSES; pass += 1) {
    const next = await reprint(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function scratchName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function standInType(dataType: string, types: readonly ReprintType[]): string {
  return typeRef(dataType, (name) => types.some((type) => type.name === name));
}

function namesType(dataType: string, name: string): boolean {
  const plain = dataType.replaceAll('"', "");
  const at = plain.indexOf(name);
  if (at === -1) return false;
  const word = /[\w$]/;
  return !word.test(plain[at - 1] ?? "") && !word.test(plain[at + name.length] ?? "");
}

/**
 * Creates a temporary enum or domain for each type the data types name.
 *
 * A type a domain's base names is created before the domain. The temporary schema is
 * searched before the target schema for types, so a column resolves to the
 * stand-in even when the schema has an older copy of the type.
 *
 * @returns The `DROP` statements for what was created, in the order to run them
 */
async function createStandIns(
  runner: CatalogQuery,
  dataTypes: readonly string[],
  types: readonly ReprintType[],
): Promise<readonly string[]> {
  if (types.length === 0) return [];
  const ordered: ReprintType[] = [];
  const seen = new Set<ReprintType>();
  const visit = (dataType: string): void => {
    for (const type of types) {
      if (seen.has(type) || !namesType(dataType, type.name)) continue;
      seen.add(type);
      if (type.base !== undefined) visit(type.base);
      ordered.push(type);
    }
  };
  for (const dataType of dataTypes) visit(dataType);
  const created: string[] = [];
  try {
    for (const type of ordered) {
      const name = quoteIdent(type.name);
      const body =
        type.labels !== undefined
          ? `as enum (${type.labels.map((label) => quoteLiteral(label)).join(", ")})`
          : `as ${standInType(type.base ?? "text", types)}`;
      const kind = type.labels !== undefined ? "type" : "domain";
      await runner.query(`create ${kind} pg_temp.${name} ${body}`);
      created.unshift(`drop ${kind} pg_temp.${name}`);
    }
  } catch (error) {
    await runDrops(runner, created);
    throw error;
  }
  return created;
}

async function runDrops(runner: CatalogQuery, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await runner.query(statement).catch(() => undefined);
}

const CHILD = "not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)";

const TABLES = `
  select c.relname as name, pt.partstrat as partstrat,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(pt.partattrs) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = c.oid and a.attnum = cols.attnum
    ) as partcols
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_partitioned_table pt on pt.partrelid = c.oid
  where n.nspname = $1
    and c.relkind in ('r', 'p')
    and ${CHILD}
    and ${member("c.oid", "pg_class")}
`;

const COLUMNS = `
  select c.relname as parent, a.attname as name,
    case
      when ty.typtype in ('e', 'd') and ty.typnamespace = n.oid then ty.typname
      when el.typtype in ('e', 'd') and el.typnamespace = n.oid and ty.typcategory = 'A'
        then el.typname || '[]'
      else format_type(a.atttypid, a.atttypmod)
    end as type,
    a.attnotnull as not_null, ${unvalidatedNotNullSql("a")} as not_null_unvalidated,
    a.attidentity as identity, a.attgenerated as generated,
    case
      when a.attcollation = 0 or a.attcollation = ty.typcollation then ''
      else coalesce((select col.collname from pg_collation col where col.oid = a.attcollation), '')
    end as collation,
    pg_get_expr(ad.adbin, ad.adrelid) as expression,
    (
      select ext.extname
      from pg_depend member
      join pg_extension ext on ext.oid = member.refobjid
      where member.objid = ty.oid and member.deptype = 'e' and member.classid = 'pg_type'::regclass
      limit 1
    ) as extension,
    (
      select owned.relname
      from pg_depend d
      join pg_class owned on owned.oid = d.objid and owned.relkind = 'S'
      where d.refobjid = c.oid and d.refobjsubid = a.attnum and d.deptype = 'a'
        and d.classid = 'pg_class'::regclass
      limit 1
    ) as sequence
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  join pg_type ty on ty.oid = a.atttypid
  left join pg_type el on el.oid = ty.typelem
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where n.nspname = $1
    and c.relkind in ('r', 'p')
    and ${CHILD}
    and ${member("c.oid", "pg_class")}
`;

function referencedNamespace(
  refSchema: string,
  concrete: string,
  logical: ReturnType<typeof staticNamespace>,
): ReturnType<typeof staticNamespace> {
  if (refSchema.length > 0 && refSchema !== concrete) return staticNamespace(refSchema);
  return logical;
}

const OUTSIDE_COLUMNS = `
  select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
    ${unvalidatedNotNullSql("a")} as not_null_unvalidated
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relname = $2
    and a.attnum > 0 and not a.attisdropped
  order by a.attnum
`;

const CONSTRAINTS = `
  select rel.relname as parent, con.conname as name, con.contype as contype,
    con.condeferrable as deferrable, con.condeferred as deferred,
    pg_get_constraintdef(con.oid) as definition,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(con.conkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = cols.attnum
    ) as columns,
    ref.relname as ref_table,
    refn.nspname as ref_schema,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(con.confkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = cols.attnum
    ) as ref_columns
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  left join pg_class ref on ref.oid = con.confrelid
  left join pg_namespace refn on refn.oid = ref.relnamespace
  where n.nspname = $1
    and con.contype in ('p', 'u', 'f', 'c')
    and not exists (select 1 from pg_inherits i where i.inhrelid = rel.oid)
`;

const INDEXES = `
  select tbl.relname as parent, idx.relname as name, i.indisunique as is_unique,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(i.indkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = tbl.oid and a.attnum = cols.attnum
      where cols.attnum > 0
    ) as columns,
    pg_get_expr(i.indexprs, i.indrelid) as expression,
    pg_get_expr(i.indpred, i.indrelid) as predicate,
    am.amname as am,
    (
      select coalesce(string_agg(opc.opcname, ',' order by cols.ord), '')
      from unnest(i.indclass) with ordinality as cols(opcoid, ord)
      join pg_opclass opc on opc.oid = cols.opcoid
    ) as opc
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  join pg_class tbl on tbl.oid = i.indrelid
  join pg_namespace n on n.oid = tbl.relnamespace
  join pg_am am on am.oid = idx.relam
  where n.nspname = $1
    and i.indisvalid
    and not i.indisprimary
    and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = tbl.oid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = idx.oid)
    and ${member("idx.oid", "pg_class")}
`;

/**
 * Indexes whose build did not finish.
 *
 * `CREATE INDEX CONCURRENTLY` leaves `indisvalid = false` when the session
 * dies. Those rows are not catalog objects: a valid index is the only shape
 * check, push, and baseline compare.
 *
 * @param runner - Database connection
 * @param schema - Concrete schema name
 * @returns Quoted `schema.name` values, in name order
 */
export async function invalidIndexNames(
  runner: CatalogQuery,
  schema: string,
): Promise<readonly string[]> {
  const rows = await runner.query(
    `select n.nspname as schema, c.relname as name
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and not i.indisvalid
     order by c.relname`,
    [schema],
  );
  return rows.map((row) => `${quoteIdent(text(row, "schema"))}.${quoteIdent(text(row, "name"))}`);
}

const DOMAINS = `
  select t.typname as name,
    format_type(t.typbasetype, t.typtypmod) as base,
    coalesce(pg_get_constraintdef(c.oid), '') as definition
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  left join pg_constraint c on c.contypid = t.oid
  where n.nspname = $1
    and t.typtype = 'd'
    and ${member("t.oid", "pg_type")}
  order by t.typname, c.conname
`;

const ENUMS = `
  select t.typname as name, e.enumlabel as label
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e on e.enumtypid = t.oid
  where n.nspname = $1
    and t.typtype = 'e'
    and ${member("t.oid", "pg_type")}
  order by t.typname, e.enumsortorder
`;

const EXTENSIONS = `
  select e.extname as name, n.nspname as schema, e.extrelocatable as relocatable,
    e.extversion as version
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where n.nspname = $1 or e.extname in (select jsonb_array_elements_text($2::text::jsonb))
`;

const FUNCTIONS = `
  select p.proname as name, l.lanname as language, p.provolatile as volatility,
    p.prosecdef as security, coalesce(p.proconfig::text, '') as config, p.prosrc as body,
    pg_get_function_result(p.oid) as returns, p.proargnames as arg_names,
    (
      select coalesce(string_agg(format_type(t.oid, null), '|' order by t.ord), '')
      from unnest(p.proargtypes) with ordinality as t(oid, ord)
    ) as arg_types,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = $1
    and p.prokind = 'f'
    and ${member("p.oid", "pg_proc")}
`;

const TRIGGERS = `
  select t.tgname as name, c.relname as parent, t.tgtype::text as tgtype,
    p.proname as function, fns.nspname as function_schema,
    (
      select coalesce(string_agg(format_type(x.oid, null), '|' order by x.ord), '')
      from unnest(p.proargtypes) with ordinality as x(oid, ord)
    ) as arg_types,
    case
      when t.tgqual is null then ''
      else coalesce(
        substring(pg_get_triggerdef(t.oid) from 'WHEN \\((.*)\\) EXECUTE'),
        ''
      )
    end as predicate,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(t.tgattr) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = cols.attnum
    ) as update_of
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace fns on fns.oid = p.pronamespace
  where n.nspname = $1
    and not t.tgisinternal
    and ${CHILD}
`;

const VIEWS = `
  select c.relname as name, c.relkind as kind, pg_get_viewdef(c.oid, true) as query,
    coalesce(array_to_string(c.reloptions, ','), '') as options,
    (
      select coalesce(string_agg(
        a.attname || '|' || format_type(a.atttypid, a.atttypmod),
        E'\\n' order by a.attnum
      ), '')
      from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relkind in ('v', 'm')
    and ${CHILD}
    and ${member("c.oid", "pg_class")}
`;

const FUNCTION_DEPS = `
  select p.proname as name,
    (
      select coalesce(string_agg(format_type(t.oid, null), '|' order by t.ord), '')
      from unnest(p.proargtypes) with ordinality as t(oid, ord)
    ) as arg_types,
    c.relname as table, coalesce(a.attname, '') as column
  from pg_depend d
  join pg_proc p on p.oid = d.objid and d.classid = 'pg_proc'::regclass
  join pg_namespace n on n.oid = p.pronamespace
  join pg_class c on c.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
  left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid and d.refobjsubid > 0
  where n.nspname = $1
    and d.deptype = 'n'
    and c.relkind in ('r', 'p')
    and p.prokind = 'f'
    and p.prosrc = ''
`;

const POLICIES = `
  select c.relname as table_name,
    p.polname as name,
    p.polcmd as command,
    coalesce(pg_get_expr(p.polqual, p.polrelid), '') as using_expr,
    c.relforcerowsecurity::text as force,
    c.relrowsecurity::text as enabled
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relkind = 'r'
    and ${CHILD}
    and ${member("c.oid", "pg_class")}
`;

function securityInvokerOption(options: string): boolean {
  return options
    .split(",")
    .some((item) => item === "security_invoker=true" || item === "security_invoker=on");
}

function policyCommand(command: string): "all" | "select" | undefined {
  if (command === "*") return "all";
  if (command === "r") return "select";
  return undefined;
}

function member(oid: string, classid: string): string {
  return `not exists (
    select 1 from pg_depend member
    where member.objid = ${oid} and member.deptype = 'e' and member.classid = '${classid}'::regclass
  )`;
}

const SEQUENCES = `
  select c.relname as name, format_type(s.seqtypid, null) as type,
    s.seqstart::text as start, s.seqincrement::text as increment, s.seqcycle as cycle,
    (
      select owned.relname
      from pg_depend d
      join pg_class owned on owned.oid = d.refobjid and owned.relkind in ('r', 'p')
      where d.objid = c.oid and d.deptype = 'a'
      limit 1
    ) as owned_table
  from pg_sequence s
  join pg_class c on c.oid = s.seqrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and ${member("c.oid", "pg_class")}
`;

function partitionMethod(value: string): "range" | "list" | "hash" | undefined {
  if (value === "r") return "range";
  if (value === "l") return "list";
  if (value === "h") return "hash";
  return undefined;
}

function constraintNameKey(
  kind: "primaryKey" | "unique" | "foreignKey" | "check",
  parent: string,
  name: string,
  columns: readonly string[],
): string {
  if (kind === "primaryKey") return "pkey";
  const tag = kind === "unique" ? "key" : kind === "foreignKey" ? "fkey" : "check";
  const prefix = `${parent}_`;
  const suffix = `_${tag}`;
  if (
    name.startsWith(prefix) &&
    name.endsWith(suffix) &&
    name.length > prefix.length + suffix.length
  ) {
    return name.slice(prefix.length, -suffix.length);
  }
  if (columns.length > 0) return columns.join("_");
  return tag;
}

function constraintKind(value: string): "primaryKey" | "unique" | "foreignKey" | "check" {
  if (value === "p") return "primaryKey";
  if (value === "u") return "unique";
  if (value === "f") return "foreignKey";
  return "check";
}

function sequenceType(value: string): "smallint" | "integer" | "bigint" {
  if (value === "smallint") return "smallint";
  if (value === "integer") return "integer";
  return "bigint";
}

function checkExpression(definition: string): string {
  // CASE is pretty-printed across lines. Those newlines are control characters,
  // so reading a check apply already accepted would raise OKM1122. Spaces
  // inside quotes stay, and the author catalog is not rewritten.
  return flattenSqlWhitespace(definition.trim().replace(/^check\s+/i, ""));
}

function flattenSqlWhitespace(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (char === "'" || char === '"') {
      const end = quotedEnd(value, index, char);
      out += value.slice(index, end);
      index = end;
      continue;
    }
    if (char === "$") {
      const tag = dollarTag(value, index);
      if (tag !== undefined) {
        const close = value.indexOf(tag, index + tag.length);
        const end = close === -1 ? value.length : close + tag.length;
        out += value.slice(index, end);
        index = end;
        continue;
      }
    }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += " ";
    } else {
      out += char;
    }
    index += 1;
  }
  return out;
}

function quotedEnd(value: string, index: number, quote: string): number {
  let cursor = index + 1;
  while (cursor < value.length) {
    if (value[cursor] !== quote) {
      cursor += 1;
      continue;
    }
    if (value[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return value.length;
}

function dollarTag(value: string, index: number): string | undefined {
  let end = index + 1;
  while (end < value.length) {
    const char = value[end] ?? "";
    if (char === "$") return value.slice(index, end + 1);
    if (!/^[A-Za-z0-9_]$/.test(char)) return undefined;
    end += 1;
  }
  return undefined;
}

/**
 * Drops one balanced outer paren pair from a trigger `WHEN` extract.
 *
 * `pg_get_triggerdef` prints `WHEN ((…))` when the author wrote `WHEN (…)`.
 * The substring capture keeps the inner wrap. Stripping it once matches the
 * text `trigger({ when })` stored, so a round trip does not plan a change.
 * `pg_get_expr(tgqual, tgrelid)` cannot be used: `OLD` and `NEW` are two
 * relations and Postgres raises "expression contains variables of more than
 * one relation" (B-46).
 *
 * @param expression - Capture from `pg_get_triggerdef`, or empty
 * @returns The predicate stored on the catalog trigger
 */
function unwrapTriggerWhen(expression: string): string {
  const body = expression.trim();
  if (!body.startsWith("(") || !body.endsWith(")")) return body;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index === body.length - 1 ? body.slice(1, -1).trim() : body;
    }
  }
  return body;
}

function actionAfter(
  definition: string,
  event: "delete" | "update",
): ReferentialAction | undefined {
  const match = new RegExp(
    `on ${event} (cascade|restrict|no action|set null|set default)\\b`,
    "i",
  ).exec(definition);
  const words = match?.[1]?.toLowerCase() ?? "";
  if (words.length === 0 || words === "no action") return undefined;
  return referentialAction(words);
}

function list(value: string): string[] {
  if (value.length === 0) return [];
  return value.split(",");
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function numberText(row: Record<string, unknown>, key: string): string {
  const value = text(row, key);
  return value.length === 0 ? "1" : value;
}

function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  return value === true || value === "true" || value === "t";
}
