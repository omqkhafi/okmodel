/**
 * Composite tenancy (`compositeTenancy()`).
 *
 * Every tenant table carries the key list, in that order. A column-only app
 * does not import this file. `via()` is a separate import: this file calls a
 * table's own `rewrite` and does not load the path compiler.
 */

import { assertIdentifier } from "../../contracts/catalog/identifier.js";
import { OkmError } from "../../contracts/error.js";
import { ColumnBuilder, retarget, type ReferenceModifier } from "../../dialects/pg/column.js";
import { assertTenantKeyType, tenantKey, tenantWire, type TenantKeyType } from "./key-type.js";
import { definition, refuseGlobalTenantIndexes } from "../../dialects/pg/misuse.js";
import type { Names } from "../../dialects/pg/casing.js";
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
import { readIndexPolicy, shapeTenantIndexes } from "./index-shape.js";

type TableOptions = {
  readonly tenancy?: unknown;
  readonly unique?: Readonly<Record<string, readonly string[]>>;
  readonly primaryKey?: readonly string[];
  readonly tenantIndexes?: boolean;
  readonly indexes?: (columns: Readonly<Record<string, { readonly name: string }>>) => readonly {
    readonly columns: readonly string[];
    readonly expression?: string;
    readonly tenantGlobal?: string;
    readonly tenantScoped?: boolean;
  }[];
};

/**
 * Composite tenancy for `schema({ tenancy })`.
 *
 * Every table gains each key unless it passes `global("reason")` or `via()`.
 * The keys are guarded uuids, in this order. Insert fills them from `for()`.
 * Reads and writes filter on every key.
 *
 * @typeParam Keys - Field names, at least one
 * `indexes` defaults to true and prefixes each ordinary index with the first
 * key. A unique index includes every key. `false` keeps OKM1706. A table's
 * `tenantIndexes` and an index `.global()` / `.scoped()` win over this.
 *
 * @param input - The key list, `uuid`, and whether indexes are prefixed
 * @returns The object `schema()` applies
 */
export function compositeTenancy<
  const Keys extends readonly [string, ...string[]],
  const Type extends TenantKeyType,
>(input: {
  readonly key: Keys;
  readonly type: Type;
  /** Prefix ordinary indexes with the first key. A unique index includes every key. Omitted is true. */
  readonly indexes?: boolean;
}): ColumnTenancy & { readonly key: Keys[number]; readonly keys: Keys; readonly type: Type } {
  if (input === undefined || typeof input !== "object") {
    definition("compositeTenancy() needs { key, type }.");
  }
  if (typeof input.type !== "string") {
    definition("compositeTenancy() type must be uuid, text, int, or bigint.");
  }
  assertTenantKeyType(input.type, "compositeTenancy()");
  const prefixIndexes = readIndexPolicy(input.indexes, "compositeTenancy()");
  const keys = readKeys(input.key) as unknown as Keys;
  const key = keys[0] ?? "";
  const built = keys.map(() => tenantKey(input.type));
  const columns = built.map((item) => item.column);
  const encodes = built.map((item) => item.encode);
  const stamp = built[0]?.stamp ?? ((wire: string) => wire);
  const tenants = new Set<string>();
  const globals = new Map<string, string>();
  const exemptions = new Map<string, { name: string; reason: string }[]>();
  const encodeKey = (name: string, value: string): string => {
    const at = keys.indexOf(name);
    const encode = at < 0 ? undefined : encodes[at];
    return encode === undefined ? value : encode(value);
  };
  const api: ColumnTenancy & { readonly key: Keys[number]; readonly keys: Keys } = {
    key: key as Keys[number],
    keys,
    type: input.type,
    strategy: "composite",
    rewrite(tables, names) {
      tenants.clear();
      globals.clear();
      exemptions.clear();
      return rewriteTables(
        keys,
        columns,
        encodes,
        api,
        tables,
        tenants,
        globals,
        exemptions,
        prefixIndexes,
        names,
      );
    },
    column: () => columns[0] ?? tenantKey(input.type).column,
    predicate(spec) {
      return writePredicate(keys, tenants, spec, encodeKey);
    },
    guard(table, field, kind) {
      if (!tenants.has(table) || !keys.includes(field)) return;
      refuseKey(kind, table, field);
    },
    stamp(table, rows, scope) {
      if (!tenants.has(table)) return;
      stampRows(keys, table, rows, scope, stamp);
    },
    client(spec): TenancyClient {
      const names = spec.scoped ? spec.names : spec.names.filter((name) => !tenants.has(name));
      if (spec.scoped) return { names };
      return { names, ...bindClient(keys, input.type, spec.open) };
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
        `Table ${table} is tenant-scoped. Call for({ ${keys.join(", ")} }).`,
      );
    },
  };
  return api as ColumnTenancy & {
    readonly key: Keys[number];
    readonly keys: Keys;
    readonly type: Type;
  };
}

function rewriteTables(
  keys: readonly string[],
  columns: readonly object[],
  encodes: readonly ((value: string) => string)[],
  api: ColumnTenancy,
  tables: readonly AnyTable[],
  tenants: Set<string>,
  globals: Map<string, string>,
  exemptions: Map<string, { name: string; reason: string }[]>,
  prefixIndexes: boolean,
  names: Names,
): readonly AnyTable[] {
  const kind = new Map<string, "tenant" | "global" | "path">();
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
      const ctx: TableRewriteContext = { tables, keys, encodes, api, extras, names };
      swapped.set(
        item.name,
        (mark.rewrite as (table: AnyTable, context: TableRewriteContext) => AnyTable)(item, ctx),
      );
      kind.set(item.name, "path");
      continue;
    }
    definition(`Table ${item.name} tenancy must be global("reason") or via().`);
  }
  return tables.map((item) => {
    const next = swapped.get(item.name);
    if (next !== undefined) return next;
    if (kind.get(item.name) === "global") {
      refuseGlobalTenantIndexes(item);
      refuseGlobalReference(item, kind);
      return item;
    }
    return rewriteTenant(
      keys,
      columns,
      item,
      tables,
      kind,
      tenants,
      exemptions,
      extras,
      prefixIndexes,
    );
  });
}

function refuseGlobalReference(
  item: AnyTable,
  kind: ReadonlyMap<string, "tenant" | "global" | "path">,
): void {
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
  keys: readonly string[],
  keyColumns: readonly object[],
  item: AnyTable,
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, "tenant" | "global" | "path">,
  tenants: Set<string>,
  exemptions: Map<string, { name: string; reason: string }[]>,
  extras: ReadonlyMap<string, readonly string[]>,
  prefixIndexes: boolean,
): AnyTable {
  for (const key of keys) {
    if (Object.hasOwn(item.columns, key)) {
      throw new OkmError(
        "OKM1012",
        `Table ${item.name} already declares ${key}, which tenancy adds. Rename the field or drop it from the table.`,
      );
    }
  }
  const options = item.options as TableOptions | undefined;
  const columns: Record<string, object> = {};
  const unique: Record<string, readonly string[]> = {};
  const named = options?.unique;
  if (named !== undefined) {
    for (const [name, fields] of Object.entries(named)) {
      unique[name] = covers(fields, keys) ? fields : [...keys, ...fields];
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
        unique[field] = [...keys, field];
      }
    }
    const reference = builder.state.references;
    if (reference !== undefined) {
      const widened = widenReference(keys, item.name, field, reference, tables, kind);
      if (widened !== undefined) patch.references = widened;
    }
    const changed =
      patch.dropUnique === true || patch.dropPrimary === true || patch.references !== undefined;
    columns[field] = changed ? retarget(builder, patch) : builder;
  }
  const primary = primaryFields(item);
  const primaryKey =
    primary.length > 0 && !covers(primary, keys) ? [...primary, ...keys] : undefined;
  if (primaryKey !== undefined) unique[`${primary.join("_")}_${keys.join("_")}`] = primaryKey;
  const declared = extras.get(item.name);
  if (declared !== undefined && declared.length > 0 && unique[declared.join("_")] === undefined) {
    unique[declared.join("_")] = declared;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const name = keys[index];
    const column = keyColumns[index];
    if (name !== undefined && column !== undefined) columns[name] = column;
  }
  tenants.add(item.name);
  if (notes.length > 0) exemptions.set(item.name, notes);
  const indexes = shapeTenantIndexes(keys, item.name, options?.indexes, {
    indexes: prefixIndexes,
    tenantIndexes: options?.tenantIndexes,
  });
  const rewritten = {
    ...item,
    columns,
    options: {
      ...options,
      ...(primaryKey !== undefined ? { primaryKey } : {}),
      ...(Object.keys(unique).length > 0 ? { unique } : {}),
      ...(indexes !== undefined ? { indexes } : {}),
      tenantKeys: keys,
    },
  };
  return declared !== undefined && declared.length > 0 ? markPathEndpoint(rewritten) : rewritten;
}

function covers(fields: readonly string[], keys: readonly string[]): boolean {
  for (const key of keys) if (!fields.includes(key)) return false;
  return true;
}

function tenantClear(action: unknown, keys: readonly string[]): string | undefined {
  if (action === "set null" || action === "set default") return action;
  if (action === null || typeof action !== "object") return undefined;
  const record = action as {
    readonly setNull?: readonly string[];
    readonly setDefault?: readonly string[];
  };
  if (record.setNull?.some((name) => keys.includes(name)) === true) return "set null";
  if (record.setDefault?.some((name) => keys.includes(name)) === true) return "set default";
  return undefined;
}

function widenReference(
  keys: readonly string[],
  table: string,
  field: string,
  reference: ReferenceModifier,
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, "tenant" | "global" | "path">,
): ReferenceModifier | undefined {
  const targetKind = kind.get(reference.table);
  if (targetKind !== "tenant") return undefined;
  const action = tenantClear(reference.onDelete, keys) ?? tenantClear(reference.onUpdate, keys);
  if (action !== undefined) {
    definition(
      `Foreign key ${table}.${field} includes ${keys.join(", ")}, so ${action} cannot clear it. Accepted actions: cascade, restrict, no action.`,
    );
  }
  const target = tables.find((item) => item.name === reference.table);
  const remote = reference.columns ?? (target === undefined ? undefined : primaryFields(target));
  if (remote === undefined || remote.length === 0) return undefined;
  const along = [...(reference.along ?? [])];
  let columns = remote;
  if (!covers(remote, keys)) columns = [...remote, ...keys];
  for (const key of keys) if (!along.includes(key)) along.push(key);
  if (covers(remote, keys) && covers(reference.along ?? [], keys)) return undefined;
  return { ...reference, columns, along };
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

function writePredicate(
  keys: readonly string[],
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
  encodeKey: (key: string, value: string) => string,
): boolean {
  if (!tenants.has(input.table)) return false;
  const scope = input.scope;
  if (scope === undefined) {
    throw new OkmError(
      "OKM1701",
      `Table ${input.table} is tenant-scoped. Call for({ ${keys.join(", ")} }).`,
    );
  }
  if ("unscoped" in scope) {
    input.sink.mark("unscoped|");
    return false;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const sql = input.fieldSql(key);
    if (sql === undefined) {
      throw new OkmError("OKM1701", `Table ${input.table} is missing its tenant key ${key}.`);
    }
    input.sink.text(index === 0 ? (input.appended ? " and " : " where ") : " and ");
    input.sink.text(input.alias);
    input.sink.text(".");
    input.sink.text(quote(sql));
    input.sink.text(" = ");
    const raw = scope.values?.[key] ?? scope.value;
    const encoded =
      keys.length === 1 && input.encode !== undefined ? input.encode(raw) : encodeKey(key, raw);
    input.sink.param(encoded);
  }
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
  keys: readonly string[],
  table: string,
  rows: Record<string, unknown>[],
  scope: TenantCall | undefined,
  stamp: (wire: string) => string | number,
): void {
  requireScope(keys, table, scope);
  if (scope === undefined || "unscoped" in scope) return;
  for (const row of rows) {
    for (const key of keys) row[key] = stamp(scope.values?.[key] ?? scope.value);
  }
}

function requireScope(
  keys: readonly string[],
  table: string,
  scope: TenantCall | undefined,
): asserts scope is { readonly value: string; readonly values?: Readonly<Record<string, string>> } {
  if (scope === undefined || "unscoped" in scope) {
    throw new OkmError(
      "OKM1701",
      `insert on ${table} has no tenant. Call for({ ${keys.join(", ")} }) so the scope can set it.`,
    );
  }
}

function bindClient(
  keys: readonly string[],
  type: TenantKeyType,
  openScope: (scope: TenantCall) => unknown,
): { for: (input: unknown) => unknown; unscoped: (reason: string) => unknown } {
  const list = keys.join(", ");
  const expect = type === "int" ? "an integer" : type === "bigint" ? "a bigint" : `a ${type}`;
  return {
    for: (input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new OkmError("OKM1701", `for() needs { ${list} }.`);
      }
      const record = input as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const key of keys) {
        values[key] = tenantWire(type, record[key], `for() needs { ${list} } as ${expect}.`);
      }
      for (const name of Object.keys(record)) {
        if (keys.includes(name)) continue;
        throw new OkmError("OKM1701", `for() accepts ${list}. ${name} is not the tenant key.`);
      }
      const first = keys[0] ?? "";
      return openScope(
        keys.length === 1 ? { value: values[first] ?? "" } : { value: values[first] ?? "", values },
      );
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

function readKeys(key: readonly string[]): readonly [string, ...string[]] {
  if (!Array.isArray(key) || key.length === 0) {
    definition(
      'compositeTenancy() key must be a list of field names, such as ["organizationId", "workspaceId"].',
    );
  }
  const keys: string[] = [];
  for (const name of key) {
    if (typeof name !== "string" || name.length === 0) {
      definition("compositeTenancy() key must be a field name.");
    }
    if (keys.includes(name)) definition(`compositeTenancy() key repeats ${name}.`);
    assertIdentifier(name, "tenancy key");
    keys.push(name);
  }
  const first = keys[0];
  if (first === undefined) definition("compositeTenancy() key needs a field name.");
  return keys as [string, ...string[]];
}

function isGlobal(value: unknown): value is { readonly kind: "global"; readonly reason: string } {
  return isRecord(value) && value.kind === "global" && typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
