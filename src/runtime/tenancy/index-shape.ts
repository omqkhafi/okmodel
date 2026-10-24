/**
 * Tenant-first index columns (Q3).
 *
 * Three levels, and the nearest one wins. `indexes` on the tenancy config
 * defaults to true and prefixes every index on a tenant table. `tenantIndexes`
 * on the table overrides that. `.global("reason")` opts one index out and
 * `.scoped()` opts one index in. An index that already leads with the tenant
 * key is not prefixed again. A `using …` tail is the index body, so it is
 * left as written and still has to lead with the key unless it is global.
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
    return calls.map((call) => shapeOne(table, tenantSql, call, policy));
  };
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
  if (wantsPrefix(call, policy) && !leads && !using) {
    return { ...call, columns: [...needed, ...call.columns] };
  }
  if (!leads && call.tenantGlobal === undefined) {
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
function wantsPrefix(
  call: IndexShapeCall,
  policy: { readonly indexes: boolean; readonly tenantIndexes?: boolean | undefined },
): boolean {
  if (call.tenantGlobal !== undefined) return false;
  if (call.tenantScoped === true) return true;
  if (policy.tenantIndexes !== undefined) return policy.tenantIndexes;
  return policy.indexes;
}
