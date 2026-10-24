/**
 * Tenant-first index columns (Q3).
 *
 * Three levels, and the nearest one wins. `indexes` on the tenancy config
 * defaults to true and prefixes every index on a tenant table. `tenantIndexes`
 * on the table overrides that. `.global("reason")` opts one index out and
 * `.scoped()` opts one index in. An index that already names the tenant key
 * moves that key to the front and does not list it again. A `using …` tail
 * is the index body, so it is left as written and still has to lead with the
 * key unless it is global.
 */

import { OkmError } from "../../contracts/error.js";
import { definition } from "../../dialects/pg/misuse.js";

/** What the prefixer reads from one index call. */
export type IndexShapeCall = {
  readonly columns: readonly string[];
  readonly expression?: string;
  /** A unique index includes every tenant key. An ordinary index includes the first. */
  readonly isUnique?: boolean;
  /** Set by `.global("reason")`. Empty is refused before this runs. */
  readonly tenantGlobal?: string;
  /** Set by `.scoped()`. */
  readonly tenantScoped?: boolean;
  /** SQL name from `.name()`. Absent means the column list names the index. */
  readonly sqlName?: string;
};

type HandleMap = Readonly<Record<string, { readonly name: string }>>;

/**
 * Reads `indexes` on `columnTenancy`, `compositeTenancy`, and `rlsTenancy`.
 *
 * Omitted is true. Anything else is a definition error.
 *
 * @param value - The option the caller passed
 * @param where - Function name used in the message
 * @returns Whether tenant indexes are prefixed
 */
export function readIndexPolicy(value: unknown, where: string): boolean {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  definition(`${where} indexes must be true or false.`);
}

/**
 * Wraps a table's `indexes` callback so the catalog sees resolved columns.
 *
 * @typeParam T - Index call, including flags the author set
 * @param keys - Tenant field names. A unique index takes every name. Another index takes the first
 * @param table - Table name, for OKM1706
 * @param build - The author's callback, when the table has indexes
 * @param policy - Config flag and the table override
 * @returns The callback `schema()` compiles, or `undefined` when there is none
 */
export function shapeTenantIndexes<T extends IndexShapeCall>(
  keys: readonly string[],
  table: string,
  build: ((columns: HandleMap) => readonly T[]) | undefined,
  policy: { readonly indexes: boolean; readonly tenantIndexes?: boolean | undefined },
): ((columns: HandleMap) => readonly T[]) | undefined {
  if (build === undefined) return undefined;
  if (policy.tenantIndexes !== undefined && typeof policy.tenantIndexes !== "boolean") {
    definition(`Table ${table} tenantIndexes must be true or false.`);
  }
  return (columns) => {
    const calls = build(columns);
    const tenantSql = sqlNames(columns, keys);
    if (!Array.isArray(calls) || tenantSql === undefined) return calls;
    const shaped = calls.map((call) => ({
      original: call.columns,
      call: shapeOne(table, tenantSql, call, policy),
    }));
    refuseSameIndex(table, shaped);
    return shaped.map((item) => item.call);
  };
}

/** Two declarations that share a name after prefixing. */
function refuseSameIndex(
  table: string,
  shaped: readonly { readonly original: readonly string[]; readonly call: IndexShapeCall }[],
): void {
  const seen = new Map<string, readonly string[]>();
  for (const item of shaped) {
    const id = item.call.sqlName ?? item.call.columns.join("\0");
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new OkmError(
        "OKM1023",
        `Index on ${table} (${listColumns(previous)}) and (${listColumns(item.original)}) both become (${listColumns(item.call.columns)}).`,
        { fix: { summary: "Drop one index, or set .name() on one of them." } },
      );
    }
    seen.set(id, item.original);
  }
}

function listColumns(columns: readonly string[]): string {
  return columns.join(", ");
}

/** SQL names for the tenant keys, or `undefined` when a handle is missing. */
function sqlNames(columns: HandleMap, keys: readonly string[]): readonly string[] | undefined {
  const names: string[] = [];
  for (const key of keys) {
    const name = columns[key]?.name;
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
}

function shapeOne<T extends IndexShapeCall>(
  table: string,
  tenantSql: readonly string[],
  call: T,
  policy: { readonly indexes: boolean; readonly tenantIndexes?: boolean | undefined },
): T {
  const needed = call.isUnique === true ? tenantSql : tenantSql.slice(0, 1);
  const leads = needed.every((name, index) => call.columns[index] === name);
  const using = call.expression?.startsWith("using ") === true;
  if (wantsPrefix(call, policy) && !using) {
    const columns = placeKeys(call.columns, needed);
    return columns === call.columns ? call : { ...call, columns };
  }
  if (!leads && call.tenantGlobal === undefined) {
    if (using) {
      throw new OkmError(
        "OKM1706",
        `Index on ${table} starts with ${call.columns[0] ?? "no column"}. A using tail is not prefixed.`,
        {
          fix: {
            summary:
              'index().global("reason") opts this index out. Putting the tenant key first does not prefix a using tail.',
          },
        },
      );
    }
    throw new OkmError(
      "OKM1706",
      `Index on ${table} starts with ${call.columns[0] ?? "no column"}. Put ${needed.join(", ")} first.`,
    );
  }
  return call;
}

/**
 * Nearest scope wins: the index flag, then the table, then the config.
 *
 * @param call - One index call
 * @param policy - Config flag and the table override
 * @returns Whether this index gains the tenant key
 */
/**
 * Moves the tenant keys to the front.
 *
 * A key already in the column list is not copied again. A list that already
 * leads with every required key is returned as it was.
 *
 * @param columns - Columns the author wrote
 * @param needed - Tenant SQL names this index must lead with
 * @returns The catalog column list
 */
function placeKeys(columns: readonly string[], needed: readonly string[]): readonly string[] {
  const leads = needed.every((name, index) => columns[index] === name);
  if (leads && needed.every((name) => columns.includes(name))) return columns;
  const rest = columns.filter((column) => !needed.includes(column));
  return [...needed, ...rest];
}

function wantsPrefix(
  call: IndexShapeCall,
  policy: { readonly indexes: boolean; readonly tenantIndexes?: boolean | undefined },
): boolean {
  if (call.tenantGlobal !== undefined) return false;
  if (call.tenantScoped === true) return true;
  if (policy.tenantIndexes !== undefined) return policy.tenantIndexes;
  return policy.indexes;
}
