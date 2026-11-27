/**
 * Sequences and numbered references (`okmodel/seq`).
 *
 * `sequence()` stores options on the column. `schema()` copies them.
 * SQL, triggers, and checks load with the planner, not with this module.
 */

import "./bind.js";
import type { CatalogObject, Namespace } from "../../../contracts/catalog/types.js";
import { sequence as sequenceObject } from "../../../contracts/catalog/object.js";
import {
  type ColumnBuilder,
  type SequenceFlags,
  type SequenceWhenFlags,
  openColumn,
} from "../column.js";
import { decodeBounded, decodeBigintString, encodeBigintString, integerToken } from "../integer.js";
import { definition } from "../misuse.js";
import { rememberGrants } from "../role/grant-slot.js";
import type { SeriesDraft, SeriesResetDraft } from "../series-slot.js";
import type { SqlText } from "../table.js";

/** SQL type of a sequence column. The default is `bigint`. */
export type SequenceType = "smallint" | "integer" | "bigint";

/** Bounds shared by a native sequence and a counter. */
export type SequenceBounds = {
  readonly start?: number | string;
  readonly increment?: number | string;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly cache?: number | string;
  readonly cycle?: boolean;
  /** Comment on the sequence. A counter stores it on the generated function. */
  readonly comment?: string;
  /** Grants on a native sequence. `usage`, `select`, and `update`. */
  readonly grants?: unknown;
};

/** Options for a series that is not yet attached to a column. */
export type SequenceOptions = SequenceBounds & {
  /** Column type. The default is `bigint`. */
  readonly as?: SequenceType;
  readonly reset?: SeriesResetDraft;
  /** Time zone for a `timestamptz` reset, such as `Asia/Riyadh`. */
  readonly at?: string;
};

/** How one column uses a series. */
export type SequenceColumnOptions = {
  /** Date or timestamptz column a reset reads. */
  readonly by?: string;
  /** Extra scope columns. A tenant table already includes its tenant keys. */
  readonly scope?: readonly string[];
  /**
   * Assigns the number when the expression is true.
   *
   * The column stays null until then.
   */
  readonly when?: (columns: Readonly<Record<string, { readonly name: string }>>) => unknown;
  /** `refuse` rejects a change of scope or `by` after a number is assigned. */
  readonly moves?: "refuse" | "renumber";
};

/** A series. `.column()` attaches it. `schema({ sequences })` declares one that no column owns. */
export type SequenceHandle = {
  readonly name: string;
  /**
   * Adds the series to a schema that lists it and no column uses it.
   *
   * @param namespace - Schema namespace
   * @param objects - Catalog objects already contributed
   */
  contribute(namespace: Namespace, objects: CatalogObject[]): void;
  /**
   * Column that draws the next value from this series.
   *
   * Insert may omit it. Update never writes it.
   *
   * @param options - Scope, reset column, and when the number is assigned
   * @returns The column
   */
  column(
    options?: SequenceColumnOptions,
  ): ColumnBuilder<number | string, SequenceFlags | SequenceWhenFlags>;
};

/**
 * A series people see, or the options of a column-owned series.
 *
 * `sequence("doc_no", options).column({ by, scope, when, moves })` shares one series.
 * `sequence(options).column()` owns the series.
 *
 * @param name - Series name, or the options when the column owns the series
 * @param options - Bounds, reset, and zone
 * @returns A handle
 */
export function sequence(): SequenceHandle;
export function sequence(name: string, options?: SequenceOptions): SequenceHandle;
export function sequence(options?: SequenceOptions): SequenceHandle;
export function sequence(
  nameOrOptions?: string | SequenceOptions,
  options?: SequenceOptions,
): SequenceHandle {
  const named = typeof nameOrOptions === "string";
  const name = named ? nameOrOptions : "";
  const spec = named ? (options ?? {}) : (nameOrOptions ?? {});
  if (name.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    definition(`sequence name ${name} must be an identifier.`);
  }
  const dataType = spec.as ?? "bigint";
  if (dataType !== "smallint" && dataType !== "integer" && dataType !== "bigint") {
    definition(`sequence as ${String(dataType)} must be smallint, integer, or bigint.`);
  }
  return {
    name,
    contribute(namespace, objects) {
      if (name.length === 0) return;
      if (objects.some((object) => object.kind === "sequence" && object.identity.name === name)) {
        return;
      }
      const schemaName = namespace.form === "static" ? namespace.name : "public";
      objects.push(
        sequenceObject({
          namespace,
          name,
          dataType,
          provenance: { origin: "file", name },
          ...(spec.comment !== undefined ? { comment: spec.comment } : {}),
          ...boundFields(spec),
        }),
      );
      if (spec.grants !== undefined) rememberGrants("sequence", schemaName, name, spec.grants);
    },
    column(use) {
      return sequenceColumn(name, dataType, spec, use) as ColumnBuilder<
        number | string,
        SequenceFlags | SequenceWhenFlags
      >;
    },
  };
}

/**
 * A stored reference such as `INV-000042`.
 *
 * `lpad` alone truncates and can repeat a value. The width is at least `pad`
 * and grows with the number. The column is stored so it can be unique.
 *
 * @param column - Number column, in SQL spelling
 * @param options - Prefix and minimum width
 * @returns Text for `.generated()`
 */
export function numbered(
  column: string,
  options: { readonly prefix: string; readonly pad: number },
): SqlText {
  if (!Number.isInteger(options.pad) || options.pad < 1) {
    definition("numbered pad must be an integer of at least 1.");
  }
  const name = `"${column.replaceAll('"', '""')}"`;
  const prefix = `'${options.prefix.replaceAll("'", "''")}'`;
  const pad = String(options.pad);
  return {
    text: `${prefix} || lpad(${name}::text, greatest(${pad}, length(${name}::text)), '0')`,
  };
}

function sequenceColumn(
  name: string,
  dataType: SequenceType,
  spec: SequenceOptions,
  use: SequenceColumnOptions | undefined,
) {
  const when = use?.when;
  const draft: SeriesDraft = {
    name,
    as: dataType,
    ...boundFields(spec),
    ...(spec.reset !== undefined ? { reset: spec.reset } : {}),
    ...(spec.at !== undefined ? { at: spec.at } : {}),
    ...(spec.comment !== undefined ? { comment: spec.comment } : {}),
    ...(spec.grants !== undefined ? { grants: spec.grants } : {}),
    ...(use?.by !== undefined ? { by: use.by } : {}),
    ...(use?.scope !== undefined ? { scope: use.scope } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(use?.moves !== undefined ? { moves: use.moves } : {}),
  };
  const nullable = when !== undefined;
  const shared = {
    nullable,
    hasDefault: true,
    generated: false,
    guarded: false,
    hidden: false,
    omitWrite: false,
    omitUpdate: true,
    sqlForm: "raw" as const,
    seriesDraft: draft,
  };
  if (dataType === "smallint") {
    return openColumn({
      ...shared,
      baseType: "smallint",
      encode: (value: number) => integerToken(value, -32_768, 32_767, "smallint"),
      decode: (wire: string) => decodeBounded(wire, -32_768, 32_767, "smallint"),
    });
  }
  if (dataType === "integer") {
    return openColumn({
      ...shared,
      baseType: "integer",
      encode: (value: number) => integerToken(value, -2_147_483_648, 2_147_483_647, "integer"),
      decode: (wire: string) => decodeBounded(wire, -2_147_483_648, 2_147_483_647, "integer"),
    });
  }
  return openColumn({
    ...shared,
    baseType: "bigint",
    encode: encodeBigintString,
    decode: decodeBigintString,
  });
}

function boundFields(spec: SequenceBounds): {
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
} {
  const start = decimal(spec.start, "sequence start");
  const increment = decimal(spec.increment, "sequence increment");
  const min = decimal(spec.min, "sequence min");
  const max = decimal(spec.max, "sequence max");
  const cache = decimal(spec.cache, "sequence cache");
  return {
    ...(start !== undefined ? { start } : {}),
    ...(increment !== undefined ? { increment } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(spec.cycle === true ? { cycle: true } : {}),
  };
}

function decimal(value: number | string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) definition(`${label} ${text} must be an integer.`);
  return text;
}
