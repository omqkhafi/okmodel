/**
 * Maps describe OIDs to Postgres type names for one connection.
 *
 * The map lives only for the call. User-type OIDs are not stable, so nothing
 * here is cached on the module. A domain becomes its base type. An array
 * becomes its element type with `[]`. An enum keeps its labels.
 */

/** Runs one catalog statement and returns wire rows. */
export type CatalogQuery = (sql: string) => Promise<readonly (readonly (string | null)[])[]>;

/**
 * A Postgres type a describe OID resolved to.
 *
 * `pgType` uses the dialect's names for built-ins (`integer`, not `int4`).
 * `enumLabels` is present for an enum and for an array of an enum.
 */
export type ResolvedType = {
  /** Type name the lock and the codecs share. */
  readonly pgType: string;
  /** Enum labels, in catalog order. */
  readonly enumLabels?: readonly string[];
};

const RENAMES: Readonly<Record<string, string>> = {
  bool: "boolean",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bpchar: "char",
};

type TypeRow = {
  readonly oid: number;
  readonly typname: string;
  readonly typtype: string;
  readonly typcategory: string;
  readonly typelem: number;
  readonly typbasetype: number;
  readonly nspname: string;
};

/**
 * Resolves `oids` through `pg_type` on one connection.
 *
 * @param query - Catalog reader for this connection. Not reused across connections
 * @param oids - Type OIDs from a describe
 * @returns OID to type. An OID the catalog does not have is `unknown`
 */
export async function resolvePgTypes(
  query: CatalogQuery,
  oids: readonly number[],
): Promise<ReadonlyMap<number, ResolvedType>> {
  const loaded = await loadTypes(query, oids);
  const labels = await loadLabels(query, loaded);
  const resolved = new Map<number, ResolvedType>();
  for (const oid of oids) resolved.set(oid, resolveOne(oid, loaded, labels, 0));
  return resolved;
}

async function loadTypes(
  query: CatalogQuery,
  oids: readonly number[],
): Promise<Map<number, TypeRow>> {
  const loaded = new Map<number, TypeRow>();
  let pending = uniqueOids(oids);
  for (let depth = 0; pending.length > 0 && depth < 8; depth += 1) {
    const rows = await query(typeSql(pending));
    pending = [];
    for (const row of rows) {
      const parsed = typeRow(row);
      if (parsed === undefined || loaded.has(parsed.oid)) continue;
      loaded.set(parsed.oid, parsed);
      if (parsed.typelem > 0 && !loaded.has(parsed.typelem)) pending.push(parsed.typelem);
      if (parsed.typbasetype > 0 && !loaded.has(parsed.typbasetype))
        pending.push(parsed.typbasetype);
    }
    pending = uniqueOids(pending);
  }
  return loaded;
}

async function loadLabels(
  query: CatalogQuery,
  loaded: ReadonlyMap<number, TypeRow>,
): Promise<ReadonlyMap<number, readonly string[]>> {
  const enums: number[] = [];
  for (const row of loaded.values()) {
    if (row.typtype === "e") enums.push(row.oid);
  }
  const labels = new Map<number, string[]>();
  if (enums.length === 0) return labels;
  for (const row of await query(enumSql(enums))) {
    const oid = integer(row[0]);
    const label = row[1];
    if (oid === undefined || label === null || label === undefined) continue;
    const list = labels.get(oid);
    if (list === undefined) labels.set(oid, [label]);
    else list.push(label);
  }
  return labels;
}

function resolveOne(
  oid: number,
  loaded: ReadonlyMap<number, TypeRow>,
  labels: ReadonlyMap<number, readonly string[]>,
  depth: number,
): ResolvedType {
  const row = loaded.get(oid);
  if (row === undefined || depth > 8) return { pgType: "unknown" };
  if (row.typtype === "d" && row.typbasetype > 0) {
    return resolveOne(row.typbasetype, loaded, labels, depth + 1);
  }
  if (row.typcategory === "A" && row.typelem > 0) {
    const element = resolveOne(row.typelem, loaded, labels, depth + 1);
    return {
      pgType: `${element.pgType}[]`,
      ...(element.enumLabels !== undefined ? { enumLabels: element.enumLabels } : {}),
    };
  }
  const pgType = sqlName(row);
  if (row.typtype === "e") return { pgType, enumLabels: labels.get(oid) ?? [] };
  return { pgType };
}

function sqlName(row: TypeRow): string {
  const name = row.nspname === "pg_catalog" ? (RENAMES[row.typname] ?? row.typname) : row.typname;
  if (row.nspname !== "pg_catalog" && row.nspname !== "public") return `${row.nspname}.${name}`;
  return name;
}

function typeSql(oids: readonly number[]): string {
  return `
SELECT t.oid::int4, t.typname, t.typtype, t.typcategory, t.typelem::int4, t.typbasetype::int4, n.nspname
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.oid = ANY(ARRAY[${oidList(oids)}]::oid[])
ORDER BY t.oid`;
}

function enumSql(oids: readonly number[]): string {
  return `
SELECT e.enumtypid::int4, e.enumlabel
FROM pg_enum e
WHERE e.enumtypid = ANY(ARRAY[${oidList(oids)}]::oid[])
ORDER BY e.enumtypid, e.enumsortorder`;
}

function typeRow(row: readonly (string | null)[]): TypeRow | undefined {
  const oid = integer(row[0]);
  const typname = row[1];
  const typtype = row[2];
  const typcategory = row[3];
  const nspname = row[6];
  if (
    oid === undefined ||
    typname === null ||
    typname === undefined ||
    typtype === null ||
    typtype === undefined ||
    typcategory === null ||
    typcategory === undefined ||
    nspname === null ||
    nspname === undefined
  ) {
    return undefined;
  }
  return {
    oid,
    typname,
    typtype,
    typcategory,
    typelem: integer(row[4]) ?? 0,
    typbasetype: integer(row[5]) ?? 0,
    nspname,
  };
}

function uniqueOids(oids: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const oid of oids) {
    if (!Number.isInteger(oid) || oid <= 0 || seen.has(oid)) continue;
    seen.add(oid);
    out.push(oid);
  }
  return out;
}

function oidList(oids: readonly number[]): string {
  const parts: string[] = [];
  for (const oid of oids) {
    if (!Number.isInteger(oid) || oid <= 0 || oid > 0xffffffff) {
      throw new Error(`oid ${String(oid)} is not a catalog oid`);
    }
    parts.push(String(oid));
  }
  if (parts.length === 0) throw new Error("oid list is empty");
  return parts.join(",");
}

function integer(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || value.length === 0) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}
