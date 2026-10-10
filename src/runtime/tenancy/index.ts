/**
 * Column tenancy (`okmodel/tenancy`).
 *
 * Importing this module is what puts tenancy on a schema. `schema()` calls
 * `rewrite` once and then compiles ordinary columns, uniques, and foreign keys.
 * The predicate and the client methods stay on this object.
 */

import { assertIdentifier } from "../../contracts/catalog/identifier.js";
import { OkmError } from "../../contracts/error.js";
import { ColumnBuilder, retarget, type ReferenceModifier } from "../../dialects/pg/column.js";
import { uuid } from "../../dialects/pg/keys.js";
import { definition } from "../../dialects/pg/misuse.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { TableRewriteContext } from "./context.js";
import { markPathEndpoint } from "../../dialects/pg/path-endpoint.js";
import type {
  ColumnTenancy,
  TenancyClient,
  TenancyRule,
  TenancyText,
  TenantCall,
} from "../../dialects/pg/tenancy.js";
import { quote } from "../plan.js";

export type { ColumnTenancy };

type Kind = "tenant" | "global" | "path";

type TableOptions = {
  readonly tenancy?: unknown;
  readonly unique?: Readonly<Record<string, readonly string[]>>;
  readonly primaryKey?: readonly string[];
  readonly indexes?: (columns: Readonly<Record<string, { readonly name: string }>>) => readonly {
    readonly columns: readonly string[];
  }[];
};

/**
 * Opts a table out of column tenancy.
 *
 * The reason is stored on the table and shown by `inspect()`.
 *
 * @param reason - Why this table is shared across tenants
 * @returns The marker `table({ tenancy })` stores
 */
export function global(reason: string): { readonly kind: "global"; readonly reason: string } {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    definition("global() needs a reason.");
  }
  return { kind: "global", reason: reason.trim() };
}

/**
 * Column tenancy for `schema({ tenancy })`.
 *
 * Every table gains `key` unless it passes `global("reason")` or `via()`.
 * The key is a guarded uuid. Insert fills it from `for()`. Reads and writes
 * filter on it. A list of keys is `compositeTenancy()`.
 *
 * @typeParam Key - Field name of the tenant key
 * @param input - Field name and `uuid`
 * @returns The object `schema()` applies
 */
export function columnTenancy<const Key>(input: {
  readonly key: Key extends readonly unknown[]
    ? "columnTenancy() takes one key. Use compositeTenancy()."
    : Key extends string
      ? Key
      : "columnTenancy() key must be a field name.";
  readonly type: "uuid";
}): ColumnTenancy & { readonly key: Key extends string ? Key : string } {
  if (input === undefined || typeof input !== "object") {
    definition("columnTenancy() needs { key, type }.");
  }
  if (input.type !== "uuid") {
    definition(`columnTenancy() type ${String(input.type)} must be uuid.`);
  }
  if (typeof input.key !== "string" || input.key.length === 0) {
    definition("columnTenancy() key must be a field name.");
  }
  assertIdentifier(input.key, "tenancy key");
  const key = input.key;
  const column = uuid().guarded();
  const encode = column.state.encode;
  const tenants = new Set<string>();
  const globals = new Map<string, string>();
  const exemptions = new Map<string, { name: string; reason: string }[]>();
  const api: ColumnTenancy & { readonly key: string } = {
    key,
    type: "uuid",
    strategy: "column",
    rewrite(tables) {
      tenants.clear();
      globals.clear();
      exemptions.clear();
      return rewriteTables(key, column, encode, api, tables, tenants, globals, exemptions);
    },
    column: () => column,
    predicate(spec) {
      return writePredicate(key, tenants, spec);
    },
    guard(table, field, kind) {
      if (!tenants.has(table) || field !== key) return;
      refuseKey(kind, table, field);
    },
    stamp(table, rows, scope) {
      if (!tenants.has(table)) return;
      stampRows(key, table, rows, scope);
    },
    client(spec): TenancyClient {
      const names = spec.scoped ? spec.names : spec.names.filter((name) => !tenants.has(name));
      if (spec.scoped) return { names };
      return { names, ...bindClient(key, encode, spec.open) };
    },
    rules(table, source, scope) {
      return tenancyRules(table, source, scope, tenants, globals, exemptions);
    },
    scopeView(name: string) {
      tenants.add(name);
    },
    hook(target, ctx) {
      if (
        ctx.tables === undefined ||
        ctx.names === undefined ||
        ctx.open === undefined ||
        ctx.scoped === undefined
      ) {
        return;
      }
      const view = api.client({ names: ctx.names, scoped: ctx.scoped, open: ctx.open });
      if (!ctx.scoped) {
        for (const name of ctx.names) {
          if (view.names.includes(name)) continue;
          delete ctx.tables[name];
          delete target[name];
        }
      }
      if (view.for !== undefined) target.for = view.for;
      if (view.unscoped !== undefined) target.unscoped = view.unscoped;
    },
    missing(table): never {
      throw new OkmError(
        "OKM1701",
        `Table ${table} is tenant-scoped. Call for({ ${key} }) or unscoped("reason").`,
      );
    },
  };
  return api as ColumnTenancy & { readonly key: Key extends string ? Key : string };
}

function rewriteTables(
  key: string,
  column: object,
  encode: (value: string) => string,
  api: ColumnTenancy,
  tables: readonly AnyTable[],
  tenants: Set<string>,
  globals: Map<string, string>,
  exemptions: Map<string, { name: string; reason: string }[]>,
): readonly AnyTable[] {
  const kind = new Map<string, Kind>();
  const swapped = new Map<string, AnyTable>();
  const extras = new Map<string, readonly string[]>();
  for (const item of tables) {
    const options = item.options as TableOptions | undefined;
    const mark = options?.tenancy;
    if (mark === undefined) {
      kind.set(item.name, "tenant");
      continue;
    }
    if (isGlobal(mark)) {
      kind.set(item.name, "global");
      globals.set(item.name, mark.reason);
      continue;
    }
    if (isRecord(mark) && typeof mark.rewrite === "function") {
      swapped.set(
        item.name,
        (mark.rewrite as (table: AnyTable, ctx: TableRewriteContext) => AnyTable)(item, {
          tables,
          keys: [key],
          encodes: [encode],
          api,
          extras,
        }),
      );
      kind.set(item.name, "path");
      continue;
    }
    definition(`Table ${item.name} tenancy must be global("reason") or via().`);
  }
  return tables.map((item) => {
    const next = swapped.get(item.name);
    if (next !== undefined) return next;
    if (kind.get(item.name) !== "tenant") {
      if (kind.get(item.name) === "global") refuseGlobalReference(item, kind);
      return item;
    }
    return rewriteTenant(key, column, item, tables, kind, tenants, exemptions, extras);
  });
}

function refuseGlobalReference(item: AnyTable, kind: ReadonlyMap<string, Kind>): void {
  for (const [field, builder] of Object.entries(item.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    const reference = builder.state.references;
    if (reference !== undefined && kind.get(reference.table) === "tenant") {
      throw new OkmError(
        "OKM1705",
        `Table ${item.name}.${field} is global and references tenant table ${reference.table}. Drop the reference, or make ${item.name} a tenant table.`,
      );
    }
  }
}

function rewriteTenant(
  key: string,
  column: object,
  item: AnyTable,
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, Kind>,
  tenants: Set<string>,
  exemptions: Map<string, { name: string; reason: string }[]>,
  extras: ReadonlyMap<string, readonly string[]>,
): AnyTable {
  if (Object.hasOwn(item.columns, key)) {
    throw new OkmError(
      "OKM1012",
      `Table ${item.name} already declares ${key}, which tenancy adds. Rename the field or drop it from the table.`,
    );
  }
  const options = item.options as TableOptions | undefined;
  const columns: Record<string, object> = {};
  const unique: Record<string, readonly string[]> = {};
  const named = options?.unique;
  if (named !== undefined) {
    for (const [name, fields] of Object.entries(named)) {
      unique[name] = fields.includes(key) ? fields : [key, ...fields];
    }
  }
  const notes: { name: string; reason: string }[] = [];
  for (const [field, builder] of Object.entries(item.columns)) {
    if (!(builder instanceof ColumnBuilder)) {
      columns[field] = builder;
      continue;
    }
    const patch: { dropUnique?: boolean; dropPrimary?: boolean; references?: ReferenceModifier } =
      {};
    if (builder.state.primaryKey === true) patch.dropPrimary = true;
    const flag = builder.state.unique;
    if (flag !== undefined) {
      if (flag.global === true) {
        const reason = flag.reason?.trim() ?? "";
        if (reason.length === 0) {
          definition(`Unique ${item.name}.${field} sets global and needs a reason.`);
        }
        notes.push({ name: field, reason });
      } else {
        patch.dropUnique = true;
        unique[field] = [key, field];
      }
    }
    const reference = builder.state.references;
    if (reference !== undefined) {
      const widened = widenReference(key, item.name, field, reference, tables, kind);
      if (widened !== undefined) patch.references = widened;
    }
    const changed =
      patch.dropUnique === true || patch.dropPrimary === true || patch.references !== undefined;
    columns[field] = changed ? retarget(builder, patch) : builder;
  }
  const primary = primaryFields(item);
  const primaryKey = primary.length > 0 && !primary.includes(key) ? [...primary, key] : undefined;
  if (primaryKey !== undefined) unique[`${primary.join("_")}_${key}`] = primaryKey;
  const noted = extras.get(item.name);
  if (noted !== undefined && noted.length > 0 && unique[noted.join("_")] === undefined) {
    unique[noted.join("_")] = noted;
  }
  columns[key] = column;
  tenants.add(item.name);
  if (notes.length > 0) exemptions.set(item.name, notes);
  const indexes = wrapIndexes(key, item.name, options?.indexes);
  const rewritten = {
    ...item,
    columns,
    options: {
      ...options,
      ...(primaryKey !== undefined ? { primaryKey } : {}),
      ...(Object.keys(unique).length > 0 ? { unique } : {}),
      ...(indexes !== undefined ? { indexes } : {}),
    },
  };
  return noted !== undefined && noted.length > 0 ? markPathEndpoint(rewritten) : rewritten;
}

function widenReference(
  key: string,
  table: string,
  field: string,
  reference: ReferenceModifier,
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, Kind>,
): ReferenceModifier | undefined {
  const targetKind = kind.get(reference.table);
  if (targetKind !== "tenant") return undefined;
  const action = [reference.onDelete, reference.onUpdate].find(
    (item) => item === "set null" || item === "set default",
  );
  if (action !== undefined) {
    definition(
      `Foreign key ${table}.${field} includes ${key}, so ${action} cannot clear it. Accepted actions: cascade, restrict, no action.`,
    );
  }
  const target = tables.find((item) => item.name === reference.table);
  const remote = reference.columns ?? (target === undefined ? undefined : primaryFields(target));
  if (remote === undefined || remote.length === 0) return undefined;
  if (remote.includes(key)) {
    if (reference.along?.includes(key)) return undefined;
    return { ...reference, along: [...(reference.along ?? []), key] };
  }
  return {
    ...reference,
    columns: [...remote, key],
    along: [...(reference.along ?? []), key],
  };
}

function primaryFields(item: AnyTable): string[] {
  const listed = (item.options as TableOptions | undefined)?.primaryKey;
  if (listed !== undefined && listed.length > 0) return [...listed];
  const fields: string[] = [];
  for (const [field, builder] of Object.entries(item.columns)) {
    if (builder instanceof ColumnBuilder && builder.state.primaryKey === true) fields.push(field);
  }
  return fields;
}

function wrapIndexes(
  key: string,
  table: string,
  build: TableOptions["indexes"],
): TableOptions["indexes"] {
  if (build === undefined) return undefined;
  return (columns) => {
    const calls = build(columns);
    const tenantSql = columns[key]?.name;
    if (!Array.isArray(calls) || tenantSql === undefined) return calls;
    for (const call of calls) {
      if (call.columns[0] === tenantSql) continue;
      throw new OkmError(
        "OKM1706",
        `Index on ${table} starts with ${call.columns[0] ?? "no column"}. Put ${tenantSql} first.`,
      );
    }
    return calls;
  };
}

function writePredicate(
  key: string,
  tenants: ReadonlySet<string>,
  input: {
    readonly table: string;
    readonly fieldSql: (field: string) => string | undefined;
    readonly encode: ((value: unknown) => string) | undefined;
    readonly alias: string;
    readonly appended: boolean;
    readonly scope: TenantCall | undefined;
    readonly sink: TenancyText;
  },
): boolean {
  if (!tenants.has(input.table)) return false;
  const scope = input.scope;
  if (scope === undefined) {
    throw new OkmError(
      "OKM1701",
      `Table ${input.table} is tenant-scoped. Call for({ ${key} }) or unscoped("reason").`,
    );
  }
  if ("unscoped" in scope) {
    input.sink.mark("unscoped|");
    return false;
  }
  const sql = input.fieldSql(key);
  if (sql === undefined) {
    throw new OkmError("OKM1701", `Table ${input.table} is missing its tenant key ${key}.`);
  }
  input.sink.text(input.appended ? " and " : " where ");
  input.sink.text(input.alias);
  input.sink.text(".");
  input.sink.text(quote(sql));
  input.sink.text(" = ");
  input.sink.param(input.encode === undefined ? scope.value : input.encode(scope.value));
  input.sink.mark("tenant|");
  return true;
}

function refuseKey(kind: "where" | "insert" | "update", table: string, field: string): never {
  if (kind === "insert") {
    throw new OkmError(
      "OKM1190",
      `Field ${table}.${field} is the tenant key. The scope sets it. Input cannot.`,
    );
  }
  if (kind === "update") {
    throw new OkmError(
      "OKM1704",
      `Field ${table}.${field} is the tenant key. An update cannot change it.`,
    );
  }
  throw new OkmError(
    "OKM1704",
    `Field ${table}.${field} is the tenant key. A filter cannot set it.`,
  );
}

function stampRows(
  key: string,
  table: string,
  rows: Record<string, unknown>[],
  scope: TenantCall | undefined,
): void {
  if (scope === undefined || "unscoped" in scope) {
    throw new OkmError(
      "OKM1701",
      `insert on ${table} has no tenant. Call for({ ${key} }) so the scope can set it.`,
    );
  }
  for (const row of rows) row[key] = scope.value;
}

function bindClient(
  key: string,
  encode: (value: string) => string,
  openScope: (scope: TenantCall) => unknown,
): { for: (input: unknown) => unknown; unscoped: (reason: string) => unknown } {
  return {
    for: (input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new OkmError("OKM1701", `for() needs { ${key} }.`);
      }
      const record = input as Record<string, unknown>;
      const value = record[key];
      if (typeof value !== "string" || value.length === 0) {
        throw new OkmError("OKM1701", `for() needs { ${key} } as a uuid.`);
      }
      for (const name of Object.keys(record)) {
        if (name !== key) {
          throw new OkmError("OKM1701", `for() accepts ${key}. ${name} is not the tenant key.`);
        }
      }
      encode(value);
      return openScope({ value });
    },
    unscoped: (reason: string) => {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        throw new OkmError("OKM1701", "unscoped() needs a reason.");
      }
      return openScope({ unscoped: reason.trim() });
    },
  };
}

function tenancyRules(
  table: string,
  source: string | undefined,
  scope: TenantCall | undefined,
  tenants: ReadonlySet<string>,
  globals: ReadonlyMap<string, string>,
  exemptions: ReadonlyMap<string, readonly { readonly name: string; readonly reason: string }[]>,
): readonly TenancyRule[] {
  const rules: TenancyRule[] = [];
  const reason = globals.get(table);
  if (reason !== undefined) {
    rules.push({
      rule: "tenancy",
      contribution: `global ${reason}`,
      provenance: "catalog",
      ...(source !== undefined ? { source } : {}),
    });
  }
  const notes = exemptions.get(table);
  if (notes !== undefined) {
    for (const item of notes) {
      rules.push({
        rule: "tenancy",
        contribution: `unique ${item.name} global ${item.reason}`,
        provenance: "catalog",
        ...(source !== undefined ? { source } : {}),
      });
    }
  }
  if (tenants.has(table) && scope !== undefined && "value" in scope) {
    rules.push({ rule: "tenancy", contribution: "scoped", provenance: "planner" });
  }
  if (scope !== undefined && "unscoped" in scope) {
    rules.push({
      rule: "tenancy",
      contribution: `unscoped ${scope.unscoped}`,
      provenance: "caller",
    });
  }
  return rules;
}

function isGlobal(value: unknown): value is { readonly kind: "global"; readonly reason: string } {
  return isRecord(value) && value.kind === "global" && typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { compositeTenancy } from "./composite.js";
export { via } from "./via.js";
