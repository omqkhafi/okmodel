/**
 * The `vector` extension (`okmodel/pg/pgvector`).
 *
 * Columns are `vector(n)` and `halfvec(n)`. Indexes are `hnsw` and `ivfflat`.
 * `distance`, `within`, and `nearest` are the query forms. The pack is a
 * subpath, the same shape as `pgTrgm`.
 */

import { OkmError } from "../../../contracts/error.js";
import { type ColumnBuilder, type PlainFlags, required } from "../column.js";
import { rejected } from "../misuse.js";
import { sqlExpression, type Fragment } from "../ops/fragment.js";
import {
  tag,
  type Nearest,
  type VectorMetric,
  type VectorQuery,
  type Within,
} from "../operators.js";
import { buildIndex, type IndexCall } from "../table.js";
import { extension, type Extension, type ExtensionOptions } from "./index.js";
import { quotedIdent } from "./using.js";

/** Largest `vector(n)` and `halfvec(n)` pgvector accepts. */
const MAX_TYPE_DIMS = 16000;

/** Largest `vector` an hnsw index accepts. */
const MAX_HNSW_VECTOR = 2000;

/** Largest `halfvec` an hnsw index accepts. */
const MAX_HNSW_HALFVEC = 4000;

/** Largest dimension an ivfflat index accepts. */
const MAX_IVFFLAT = 2000;

const OPERATORS = { cosine: "<=>", l2: "<->", ip: "<#>" } as const;

const VECTOR_INDEX =
  /^using (hnsw|ivfflat) \("((?:[^"]|"")*)" ((vector|halfvec)_(cosine|l2|ip)_ops)\)$/;

/** A column name, or the handle `indexes` passes, which carries the SQL type. */
export type VectorColumn = string | { readonly name: string; readonly dataType?: string };

/** Options for {@link PgVector.hnsw}. `metric` has no default. */
export type HnswOptions = {
  readonly metric: VectorMetric;
  /** Graph degree. Stored as the reloption `m`. */
  readonly m?: number;
  /** Candidate list at build time. Stored as the reloption `ef_construction`. */
  readonly efConstruction?: number;
};

/** Options for {@link PgVector.ivfflat}. `lists` is required. */
export type IvfflatOptions = {
  readonly metric: VectorMetric;
  /** Number of lists. Stored as the reloption `lists`. */
  readonly lists: number;
};

/**
 * The `vector` extension and its typed columns, indexes, and query forms.
 */
export type PgVector = Extension & {
  /**
   * A `vector(n)` column. The value is `number[]`. The wire text is `[1,2,3]`.
   *
   * @param dims - Dimensions, from 1 to 16000
   * @returns The column
   */
  vector(dims: number): ColumnBuilder<number[], PlainFlags>;
  /**
   * A `halfvec(n)` column. The value is `number[]`. The wire text is `[1,2,3]`.
   *
   * @param dims - Dimensions, from 1 to 16000
   * @returns The column
   */
  halfvec(dims: number): ColumnBuilder<number[], PlainFlags>;
  /**
   * An hnsw index on one vector or halfvec column.
   *
   * Pass the column handle from `indexes` so the operator class follows the
   * column type. A bare name is resolved the same way when `schema()` runs.
   *
   * @param column - Column name or handle
   * @param options - Metric, and optional `m` and `efConstruction`
   * @returns The index call
   */
  hnsw(column: VectorColumn, options: HnswOptions): IndexCall;
  /**
   * An ivfflat index on one vector or halfvec column.
   *
   * @param column - Column name or handle
   * @param options - Metric and `lists`
   * @returns The index call
   */
  ivfflat(column: VectorColumn, options: IvfflatOptions): IndexCall;
  /**
   * Distance from a column to a query, as a select entry.
   *
   * `<#>` is the negative inner product. Call `.as("distance")` to name the result.
   *
   * @param column - Field name
   * @param query - Query vector. Finite numbers, and not empty
   * @param metric - `cosine`, `l2`, or `ip`
   * @returns A select fragment
   */
  distance(column: string, query: readonly number[], metric: VectorMetric): Fragment;
  /**
   * A where fragment: the distance is at most `max`.
   *
   * @param query - Query vector
   * @param options - Metric and the maximum distance
   * @returns The where operand
   */
  within(
    query: readonly number[],
    options: { readonly metric: VectorMetric; readonly max: number },
  ): Within;
  /**
   * An orderBy value: nearest first. Same tagged arm as `relevance()`.
   *
   * @param query - Query vector
   * @param metric - `cosine`, `l2`, or `ip`
   * @returns The order operand
   */
  nearest(query: readonly number[], metric: VectorMetric): Nearest;
};

/**
 * Declares the `vector` extension.
 *
 * There is no version pin. The install schema defaults to `public`.
 *
 * @param options - Schema, when it is not `public`
 * @returns The pack
 */
export function pgvector(options?: ExtensionOptions): PgVector {
  const declared = extension("vector", options);
  const schemaName = declared.schema;
  return {
    ...declared,
    vector: (dims) => vectorColumn("vector", dims),
    halfvec: (dims) => vectorColumn("halfvec", dims),
    hnsw: (column, hnswOptions) => vectorIndex("hnsw", column, hnswOptions),
    ivfflat: (column, ivfflatOptions) => vectorIndex("ivfflat", column, ivfflatOptions),
    distance(column, query, metric) {
      const chosen = requireMetric("distance", column, metric);
      return sqlExpression([
        { k: "i", n: column },
        { k: "t", s: ` operator(${quotedIdent(schemaName)}.${OPERATORS[chosen]}) ` },
        { k: "p", v: encodeVector(query) },
      ]);
    },
    within(query, withinOptions) {
      const chosen = requireMetric("within", "query", withinOptions.metric);
      if (typeof withinOptions.max !== "number" || !Number.isFinite(withinOptions.max)) {
        refuse("within needs a finite max.");
      }
      return tag("within", {
        ...encodeQuery(query, chosen, schemaName),
        max: withinOptions.max,
      });
    },
    nearest(query, metric) {
      const chosen = requireMetric("nearest", "query", metric);
      return tag("nearest", encodeQuery(query, chosen, schemaName));
    },
    contribute(peers, built) {
      alignVectorIndexes(built);
      return declared.contribute(peers, built);
    },
  };
}

export type { VectorMetric };

/**
 * Builds a vector or halfvec column.
 *
 * @param kind - `vector` or `halfvec`
 * @param dims - Dimensions
 * @returns The column
 */
function vectorColumn(
  kind: "vector" | "halfvec",
  dims: number,
): ColumnBuilder<number[], PlainFlags> {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_TYPE_DIMS) {
    const why =
      typeof dims === "number" && dims > MAX_TYPE_DIMS
        ? `${kind}(${String(dims)}) is above ${MAX_TYPE_DIMS} dimensions.`
        : `${kind}(${String(dims)}) needs a dimension from 1 to ${MAX_TYPE_DIMS}.`;
    refuse(why);
  }
  return required({
    baseType: `${kind}(${String(dims)})`,
    encode: (value) => encodeVector(value, dims),
    decode: decodeVector,
    sqlForm: "quote",
    extension: "vector",
    accepts: ["Array"],
  });
}

/**
 * Builds an hnsw or ivfflat index call.
 *
 * The operator class uses the handle's type when it is known. `schema()`
 * rewrites it from the column when the handle did not carry a type.
 *
 * @param method - `hnsw` or `ivfflat`
 * @param column - Column name or handle
 * @param options - Metric and storage
 * @returns The index call
 */
function vectorIndex(
  method: "hnsw" | "ivfflat",
  column: VectorColumn,
  options: {
    readonly metric: VectorMetric;
    readonly m?: number;
    readonly efConstruction?: number;
    readonly lists?: number;
  },
): IndexCall {
  const name = columnName(column);
  const metric = requireMetric(method, name, options.metric);
  if (method === "ivfflat" && options.lists === undefined) {
    refuse(`ivfflat on ${name} needs lists.`);
  }
  const family = columnFamily(column) ?? "vector";
  const storage = indexStorage(method, options);
  return buildIndex({
    columns: [name],
    expression: `using ${method} (${quotedIdent(name)} ${family}_${metric}_ops)`,
    nameKey: `${name}_${method}_${metric}`,
    ...(storage === undefined ? {} : { storage }),
  });
}

/**
 * Reads the SQL name from a string or a column handle.
 *
 * @param column - Column name or handle
 * @returns The SQL name
 */
function columnName(column: VectorColumn): string {
  return typeof column === "string" ? column : column.name;
}

/**
 * Reads `vector` or `halfvec` from a handle's SQL type.
 *
 * @param column - Column name or handle
 * @returns The family, when the handle carries it
 */
function columnFamily(column: VectorColumn): "vector" | "halfvec" | undefined {
  if (typeof column === "string" || column.dataType === undefined) return undefined;
  if (column.dataType.startsWith("halfvec(")) return "halfvec";
  if (column.dataType.startsWith("vector(")) return "vector";
  return undefined;
}

/**
 * Storage parameters for one index. Absent keys stay at the server default.
 *
 * @param method - `hnsw` or `ivfflat`
 * @param options - Caller options
 * @returns The reloption map, or `undefined` when nothing was set
 */
function indexStorage(
  method: "hnsw" | "ivfflat",
  options: { readonly m?: number; readonly efConstruction?: number; readonly lists?: number },
): Readonly<Record<string, string>> | undefined {
  const storage: Record<string, string> = {};
  if (method === "hnsw") {
    if (options.m !== undefined) storage.m = positiveInteger("m", options.m);
    if (options.efConstruction !== undefined) {
      storage.ef_construction = positiveInteger("ef_construction", options.efConstruction);
    }
  }
  if (method === "ivfflat" && options.lists !== undefined) {
    storage.lists = positiveInteger("lists", options.lists);
  }
  return Object.keys(storage).length === 0 ? undefined : storage;
}

/**
 * Checks one storage parameter.
 *
 * @param name - Reloption name
 * @param value - Caller value
 * @returns The decimal text
 */
function positiveInteger(name: string, value: number): string {
  if (!Number.isInteger(value) || value < 1) refuse(`${name} needs a positive integer.`);
  return String(value);
}

/**
 * Checks the metric. There is no default operator class.
 *
 * @param method - What the caller built
 * @param column - Column or query name, for the message
 * @param metric - Caller value
 * @returns The metric
 */
function requireMetric(method: string, column: string, metric: unknown): VectorMetric {
  if (metric === "cosine" || metric === "l2" || metric === "ip") return metric;
  refuse(`${method} on ${column} needs a metric: cosine, l2, or ip.`);
}

/**
 * Encodes a query vector and remembers its length for the column check.
 *
 * @param query - Query vector
 * @param metric - Distance metric
 * @param schemaName - Extension schema
 * @returns The operand `within` and `nearest` store
 */
function encodeQuery(
  query: readonly number[],
  metric: VectorMetric,
  schemaName: string,
): VectorQuery {
  return { text: encodeVector(query), metric, schema: schemaName, dims: query.length };
}

/**
 * Encodes a vector as pgvector text.
 *
 * Plain finite numbers only. An empty array is refused. When `dims` is set,
 * the length must match the column.
 *
 * @param value - Caller value
 * @param dims - Column dimensions, when this is a column write
 * @returns Text such as `[1,2,3]`
 */
function encodeVector(value: unknown, dims?: number): string {
  if (!Array.isArray(value) || value.length === 0) {
    rejected("A vector needs one or more finite numbers.");
  }
  if (dims !== undefined && value.length !== dims) {
    rejected(
      `This vector has ${String(value.length)} dimensions and the column has ${String(dims)}.`,
    );
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      rejected("A vector needs finite numbers.");
    }
    parts.push(Object.is(item, -0) ? "0" : String(item));
  }
  return `[${parts.join(",")}]`;
}

/**
 * Decodes pgvector text.
 *
 * @param wire - Text such as `[1,2,3]`
 * @returns The numbers
 */
function decodeVector(wire: string): number[] {
  if (wire.length < 2 || wire.charCodeAt(0) !== 91 || wire.charCodeAt(wire.length - 1) !== 93) {
    rejected("A vector value must look like [1,2,3].");
  }
  const body = wire.slice(1, -1).trim();
  if (body.length === 0) rejected("A vector value must look like [1,2,3].");
  return body.split(",").map((part) => {
    const parsed = Number(part.trim());
    if (!Number.isFinite(parsed)) rejected("A vector value must be finite numbers.");
    return parsed;
  });
}

/**
 * Rewrites operator classes from the column type and refuses illegal indexes.
 *
 * Index jobs run before the extension record, so the column type is already
 * staged. The expression is updated in place; the catalog hash sees the result.
 *
 * @param built - Objects `schema()` has staged
 */
function alignVectorIndexes(built: unknown): void {
  if (!Array.isArray(built)) return;
  const types = new Map<string, string>();
  for (const object of built) {
    const column = readColumn(object);
    if (column !== undefined) types.set(`${column.table}\0${column.name}`, column.dataType);
  }
  const seen = new Set<string>();
  for (const object of built) {
    const index = readVectorIndex(object);
    if (index === undefined) continue;
    const dataType = types.get(`${index.table}\0${index.column}`);
    const parsed = /^(vector|halfvec)\((\d+)\)$/.exec(dataType ?? "");
    if (parsed === null) {
      refuse(`${index.method} on ${index.table}.${index.column} needs a vector or halfvec column.`);
    }
    const family = parsed[1] === "halfvec" ? "halfvec" : "vector";
    const dims = Number(parsed[2]);
    const next = index.expression.replace(
      /(?:vector|halfvec)_(cosine|l2|ip)_ops\)$/,
      `${family}_$1_ops)`,
    );
    if (next !== index.expression) index.write(next);
    const limit =
      index.method === "hnsw"
        ? family === "halfvec"
          ? MAX_HNSW_HALFVEC
          : MAX_HNSW_VECTOR
        : MAX_IVFFLAT;
    if (dims > limit) {
      const tail = index.method === "hnsw" ? ` for ${family}` : "";
      refuse(
        `${index.method} on ${index.table}.${index.column} is above ${String(limit)} dimensions${tail}.`,
      );
    }
    const key = `${index.table}\0${index.column}\0${index.metric}`;
    if (seen.has(key))
      refuse(`${index.table}.${index.column} already has a ${index.metric} index.`);
    seen.add(key);
  }
}

type StagedColumn = { readonly table: string; readonly name: string; readonly dataType: string };

type StagedVectorIndex = {
  readonly table: string;
  readonly column: string;
  readonly method: "hnsw" | "ivfflat";
  readonly metric: VectorMetric;
  readonly expression: string;
  readonly write: (expression: string) => void;
};

/**
 * Reads a staged column.
 *
 * @param object - One catalog object
 * @returns The table, name, and type, when this is a column
 */
function readColumn(object: unknown): StagedColumn | undefined {
  if (!isRecord(object) || object.kind !== "column") return undefined;
  const identity = isRecord(object.identity) ? object.identity : undefined;
  const parent = identity !== undefined && isRecord(identity.parent) ? identity.parent : undefined;
  const definition = isRecord(object.definition) ? object.definition : undefined;
  if (identity === undefined || parent === undefined || definition === undefined) return undefined;
  if (typeof identity.name !== "string" || typeof parent.name !== "string") return undefined;
  if (typeof definition.dataType !== "string") return undefined;
  return { table: parent.name, name: identity.name, dataType: definition.dataType };
}

/**
 * Reads a staged hnsw or ivfflat vector index.
 *
 * @param object - One catalog object
 * @returns The parsed index, when the expression is one of ours
 */
function readVectorIndex(object: unknown): StagedVectorIndex | undefined {
  if (!isRecord(object) || object.kind !== "index") return undefined;
  const identity = isRecord(object.identity) ? object.identity : undefined;
  const parent = identity !== undefined && isRecord(identity.parent) ? identity.parent : undefined;
  const definition = isRecord(object.definition) ? object.definition : undefined;
  if (parent === undefined || definition === undefined || typeof parent.name !== "string")
    return undefined;
  if (typeof definition.expression !== "string") return undefined;
  const match = VECTOR_INDEX.exec(definition.expression);
  if (match === null) return undefined;
  const method = match[1] === "ivfflat" ? "ivfflat" : "hnsw";
  const metric = match[5];
  if (metric !== "cosine" && metric !== "l2" && metric !== "ip") return undefined;
  const expression = definition.expression;
  return {
    table: parent.name,
    column: (match[2] ?? "").replaceAll('""', '"'),
    method,
    metric,
    expression,
    write(next) {
      definition.expression = next;
    },
  };
}

/**
 * Reports whether `value` is a plain record.
 *
 * @param value - Unknown value
 * @returns `true` for a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Throws OKM1930.
 *
 * @param message - What is wrong
 * @returns Never
 */
function refuse(message: string): never {
  throw new OkmError("OKM1930", message, {
    fix: {
      summary:
        "Use one metric per column, and stay within the dimension limits: vector and halfvec to 16000, hnsw to 2000 for vector and 4000 for halfvec, ivfflat to 2000.",
    },
  });
}
