/**
 * Reads a Postgres schema into a catalog.
 *
 * Copied partition primary keys and inherited indexes are not objects: a
 * relation that is a child in `pg_inherits` is skipped, and so is an index
 * that is itself inherited (M0-06). Expressions come back from `pg_get_expr`
 * and `pg_get_constraintdef`, which is the database's normalised text (D128).
 */

import { catalog } from "../../contracts/catalog/build.js";
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
import { quoteIdent } from "./ddl.js";
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
    runner.query(EXTENSIONS, params),
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
    const built: ColumnObject = column({
      parent,
      name: text(row, "name"),
      dataType,
      nullable: !flag(row, "not_null"),
      provenance,
      ...(extra.length > 0 ? { dependencies: extra } : {}),
      ...(identity === "a" || identity === "d" ? { identity: { always: identity === "a" } } : {}),
      ...(generated ? { generated: { stored: true, expression } } : {}),
      ...(!generated && identity !== "a" && identity !== "d" && expression.length > 0
        ? { defaultExpression: expression }
        : {}),
      ...(collation.length > 0 ? { collation } : {}),
    });
    objects.push(built);
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
                parent: { namespace, name: refTable },
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
    const when = text(row, "predicate");
    const argTypes = splitTypes(text(row, "arg_types"));
    objects.push(
      triggerObject({
        parent: { namespace, name: text(row, "parent") },
        name: text(row, "name"),
        timing: triggerTiming(bits),
        events: triggerEvents(bits),
        level: (bits & 1) === 1 ? "row" : "statement",
        calls: {
          namespace: staticNamespace(text(row, "function_schema")),
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
    if (command === undefined) continue;
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
        namespace,
        provenance,
        objects,
        options.managedRoles,
      )),
    );
  }
  return catalog(objects);
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
  namespace: ReturnType<typeof staticNamespace>,
  provenance: Provenance,
  built: readonly CatalogObject[],
  managedRoles: readonly string[],
): Promise<CatalogObject[]> {
  const managed = new Set(managedRoles);
  const [roles, relations, functions, defaults] = await Promise.all([
    runner.query(ROLES, []),
    runner.query(RELATION_GRANTS, [concrete]),
    runner.query(FUNCTION_GRANTS, [concrete]),
    runner.query(DEFAULT_PRIVILEGES, [concrete]),
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

function atomicBody(definition: string): string {
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

/**
 * Applies one expression as a check and reads Postgres's reprint.
 *
 * Two authoring spellings of the same predicate compare equal after this.
 * A different predicate does not.
 *
 * @param runner - Database connection
 * @param expression - Check expression without the `CHECK` keyword
 * @returns The reprinted expression, without the `CHECK` keyword
 */
export async function reprintCheck(runner: CatalogQuery, expression: string): Promise<string> {
  await runner.query("drop table if exists okm_expr");
  await runner.query("create table okm_expr (id integer, title text)");
  await runner.query(`alter table okm_expr add constraint okm_expr_check check (${expression})`);
  const rows = await runner.query(
    "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'okm_expr_check'",
  );
  await runner.query("drop table okm_expr");
  return checkExpression(text(rows[0] ?? {}, "definition"));
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
      when ty.typtype = 'e' and ty.typnamespace = n.oid then ty.typname
      else format_type(a.atttypid, a.atttypmod)
    end as type,
    a.attnotnull as not_null, a.attidentity as identity, a.attgenerated as generated,
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
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where n.nspname = $1
    and c.relkind in ('r', 'p')
    and ${CHILD}
    and ${member("c.oid", "pg_class")}
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
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(con.confkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = cols.attnum
    ) as ref_columns
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  left join pg_class ref on ref.oid = con.confrelid
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
    and not i.indisprimary
    and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = tbl.oid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = idx.oid)
    and ${member("idx.oid", "pg_class")}
`;

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
  where n.nspname = $1
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
    coalesce(pg_get_expr(t.tgqual, t.tgrelid), '') as predicate,
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
    c.relforcerowsecurity::text as force
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
  return definition.trim().replace(/^check\s+/i, "");
}

function actionAfter(
  definition: string,
  event: "delete" | "update",
): ReferentialAction | undefined {
  const match = new RegExp(`on ${event} ([a-z ]+)`, "i").exec(definition);
  const words = match?.[1]?.trim().toLowerCase() ?? "";
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
