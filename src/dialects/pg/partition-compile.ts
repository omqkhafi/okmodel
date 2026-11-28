/**
 * Partition rules held on a table and compiled with the catalog.
 *
 * `schema()` stores the author's option. This module runs on the first catalog
 * read, on plan, and on `okm partitions`. A featureless query does not import it.
 */

import { OkmError } from "../../contracts/error.js";
import type {
  Catalog,
  CatalogObject,
  ObjectIdentity,
  TablePartition,
} from "../../contracts/catalog/types.js";
import type {
  PartitionBound,
  PartitionChild,
  PartitionMethod,
  PartitionRule,
} from "../../contracts/catalog/types.js";

type ZoneSpan = {
  readonly years?: number;
  readonly months?: number;
  readonly weeks?: number;
  readonly days?: number;
};

type ZoneInstant = {
  readonly epochMilliseconds: number;
  toZonedDateTimeISO(zone: string): ZoneZoned;
};

type ZoneZoned = {
  toInstant(): ZoneInstant;
  toPlainDate(): ZoneDate;
  toPlainDateTime(): {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
  };
  subtract(span: ZoneSpan): ZoneZoned;
};

type ZoneDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly dayOfWeek: number;
  add(duration: ZoneSpan): ZoneDate;
  subtract(duration: ZoneSpan): ZoneDate;
  since(other: ZoneDate, options: { readonly largestUnit: "days" }): { readonly days: number };
  toPlainDateTime(): { toZonedDateTime(zone: string): { toInstant(): ZoneInstant } };
  toString(): string;
};

type ZoneApi = {
  readonly Now: { instant(): ZoneInstant };
  readonly Instant: {
    from(text: string): ZoneInstant;
    compare(left: ZoneInstant, right: ZoneInstant): number;
  };
  readonly PlainDate: {
    from(
      value: string | { readonly year: number; readonly month: number; readonly day: number },
    ): ZoneDate;
    compare(left: ZoneDate, right: ZoneDate): number;
  };
  readonly PlainDateTime: {
    from(text: string): { toZonedDateTime(zone: string): { toInstant(): ZoneInstant } };
  };
};

function zones(): ZoneApi {
  return Temporal as unknown as ZoneApi;
}

/** A column the compiler can see. Names are the field and the SQL name. */
export type PartitionColumnInfo = {
  readonly field: string;
  readonly sql: string;
  readonly dataType: string;
  readonly generated: boolean;
};

/** What the planner should do when the live table and the declaration differ. */
export type PartitionChange =
  | { readonly kind: "same" }
  | { readonly kind: "attach"; readonly missing: readonly PartitionChild[] }
  | {
      readonly kind: "convert";
      /** The existing table becomes this child. */
      readonly attach: PartitionChild;
      readonly others: readonly PartitionChild[];
    };

const TIME_UNITS = new Set(["year", "quarter", "month", "week", "day"]);

/**
 * Compiles `partition` and `partitions` into the catalog value.
 *
 * Throws OKM1932 when the option cannot be planned. A generated key is
 * OKM1920, the code the rest of the catalog already uses.
 *
 * @param table - SQL table name
 * @param partition - Author `partition` option, or `undefined`
 * @param partitions - Author `partitions` map, or `undefined`
 * @param columns - Columns of the table
 * @param keys - Primary, unique, and exclusion column lists, in SQL names
 * @param now - Clock for the ahead window. The default is the current instant
 * @returns The catalog partition, or `undefined` when the table has none
 */
export function compilePartition(input: {
  readonly table: string;
  readonly partition: unknown;
  readonly partitions: unknown;
  readonly columns: readonly PartitionColumnInfo[];
  readonly keys: readonly (readonly string[])[];
  readonly now?: ZoneInstant;
}): TablePartition | undefined {
  if (input.partition === undefined && input.partitions === undefined) return undefined;
  if (input.partition === undefined) {
    refuse(
      `Table ${input.table} sets partitions without partition.`,
      "Set partition: { by, key } next to partitions.",
    );
  }
  const option = record(input.partition, `Table ${input.table} partition`);
  const by = text(option.by, "partition.by") as PartitionMethod;
  if (by !== "range" && by !== "list" && by !== "hash") {
    refuse(
      `Table ${input.table} partition.by must be range, list, or hash.`,
      "Use range, list, or hash.",
    );
  }
  const keyFields = keyList(option.key);
  if (keyFields.length === 0) {
    refuse(`Table ${input.table} partition.key needs a column.`, "Name the partition columns.");
  }
  const keyColumns = keyFields.map((field) => {
    const column = input.columns.find((item) => item.field === field);
    if (column === undefined) {
      refuse(
        `Table ${input.table} partition key ${field} is not a column.`,
        "Name a column of this table.",
      );
    }
    if (column.generated) {
      throw new OkmError(
        "OKM1920",
        `Partition key ${input.table}.${column.sql} is generated. PostgreSQL refuses a generated partition key.`,
        { fix: { summary: "Partition by a base column." } },
      );
    }
    return column;
  });
  for (const columns of input.keys) {
    const missing = keyColumns.filter((column) => !columns.includes(column.sql));
    if (missing.length > 0) {
      refuse(
        `Table ${input.table} primary key, unique, or exclusion must include partition column ${missing.map((column) => column.sql).join(", ")}. PostgreSQL returns 0A000 otherwise.`,
        "Add every partition column to the primary key, the unique constraint, and the exclusion.",
      );
    }
  }
  if (option.children === "external") {
    if (
      input.partitions !== undefined ||
      option.every !== undefined ||
      option.count !== undefined
    ) {
      refuse(
        `Table ${input.table} is external and also managed. A table is one or the other.`,
        'Use children: "external" alone, or remove it and let OKM own the children.',
      );
    }
    return {
      method: by,
      columns: keyColumns.map((column) => column.sql),
      ownership: "external",
    };
  }
  if (
    input.partitions !== undefined &&
    (option.every !== undefined || option.count !== undefined)
  ) {
    refuse(
      `Table ${input.table} sets a rule and an explicit partitions map.`,
      "Use a rule, a hash count, or partitions. Not more than one.",
    );
  }
  const columns = keyColumns.map((column) => column.sql);
  if (
    by === "range" &&
    isTimestamptz(keyColumns[0]?.dataType ?? "") &&
    typeof option.at !== "string"
  ) {
    refuse(
      `Table ${input.table} timestamptz key ${keyColumns[0]?.sql ?? ""} needs partition.at.`,
      "Set at to an IANA time zone. Bounds are written with that zone's offset.",
    );
  }
  if (by === "hash") {
    const count = option.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      refuse(`Table ${input.table} hash partition needs count of 1 or more.`, "Set count.");
    }
    const children: PartitionChild[] = [];
    for (let remainder = 0; remainder < count; remainder += 1) {
      children.push({
        suffix: `h${String(remainder)}`,
        bound: { kind: "hash", modulus: count, remainder },
      });
    }
    return { method: by, columns, ownership: "managed", count, children };
  }
  if (option.every !== undefined) {
    if (keyColumns.length !== 1) {
      refuse(
        `Table ${input.table} rule needs one key column.`,
        "Use one column, or list the partitions.",
      );
    }
    const column = keyColumns[0];
    if (column === undefined) refuse(`Table ${input.table} rule needs a key.`, "Name the key.");
    const rule = compileRule(input.table, option, column, input.now ?? zones().Now.instant());
    const children = expandRule(input.table, column, rule, input.now ?? zones().Now.instant());
    return { method: by, columns, ownership: "managed", rule, children };
  }
  const children = compileExplicit(
    input.table,
    by,
    keyColumns,
    input.partitions,
    typeof option.at === "string" ? option.at : undefined,
  );
  return { method: by, columns, ownership: "managed", children };
}

/**
 * Refuses a foreign key whose target is partitioned and whose columns omit a key.
 *
 * @param objects - Catalog objects, after every table is compiled
 */
export function refusePartitionForeignKeys(objects: readonly CatalogObject[]): void {
  const keys = new Map<string, readonly string[]>();
  for (const object of objects) {
    if (object.kind === "table" && object.definition.partition !== undefined) {
      keys.set(object.identity.name, object.definition.partition.columns);
    }
  }
  for (const object of objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    const needed = keys.get(references.parent.name);
    if (needed === undefined) continue;
    const missing = needed.filter((column) => !references.columns.includes(column));
    if (missing.length === 0) continue;
    refuse(
      `Foreign key ${object.identity.name} references partitioned table ${references.parent.name} without partition column ${missing.join(", ")}. PostgreSQL requires a unique key that includes every partition column.`,
      "Include the partition columns in the foreign key.",
    );
  }
}

/**
 * Compares a live partition with the declaration.
 *
 * A rule field is ignored. Children compare as instants. An external declaration
 * ignores children that already exist. Changing the method, the key, or a hash
 * count throws OKM1932.
 *
 * @param before - Partition read from the database. Absent when the table is plain
 * @param after - Partition the schema declares. Absent when the table is plain
 * @returns The change the planner should emit
 */
export function partitionChange(
  before: TablePartition | undefined,
  after: TablePartition | undefined,
): PartitionChange {
  if (before === undefined && after === undefined) return { kind: "same" };
  if (before === undefined && after !== undefined) {
    if (after.ownership === "external") return { kind: "same" };
    const children = after.children ?? [];
    const attach = children[0];
    if (attach === undefined) {
      refuse(
        "Converting a plain table needs at least one partition.",
        "Declare a range, a list, or a hash count before converting.",
      );
    }
    return { kind: "convert", attach, others: children.slice(1) };
  }
  if (before !== undefined && after === undefined) {
    refuse(
      "Removing partition from a partitioned table is not planned.",
      "Detach the children with okm partitions maintain, then change the table in its own step.",
    );
  }
  if (before === undefined || after === undefined) return { kind: "same" };
  if (before.method !== after.method || !sameColumns(before.columns, after.columns)) {
    refuse(
      `Partition key of ${after.columns.join(", ")} (${after.method}) does not match the live ${before.columns.join(", ")} (${before.method}).`,
      "Keep the method and the key. A change needs a new table and a copy.",
    );
  }
  if (after.ownership === "external") return { kind: "same" };
  if (after.method === "hash" && after.count !== undefined) {
    const live = (before.children ?? []).filter((child) => child.bound.kind === "hash").length;
    if (live > 0 && live !== after.count) {
      refuse(
        `Hash count is ${String(after.count)} and the table has ${String(live)} partitions. PostgreSQL cannot change the modulus in place.`,
        "Create a new hash table and copy the rows.",
      );
    }
  }
  const missing = missingChildren(before.children ?? [], after.children ?? []);
  if (missing.length === 0) return { kind: "same" };
  return { kind: "attach", missing };
}

/**
 * Names views and inbound foreign keys that block conversion.
 *
 * @param table - SQL table name
 * @param catalog - Catalog that already contains the plain table
 * @returns One line per blocker. Empty when conversion can run
 */
export function conversionBlockers(table: string, catalog: Catalog): readonly string[] {
  const blockers: string[] = [];
  for (const object of catalog.objects) {
    if (
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.definition.references?.parent.name === table
    ) {
      blockers.push(`inbound foreign key ${object.identity.parent.name}.${object.identity.name}`);
    }
    if (
      (object.kind === "view" || object.kind === "materializedView") &&
      object.dependencies.some((edge) => dependsOnTable(edge.target, table))
    ) {
      blockers.push(
        `${object.kind === "view" ? "view" : "materialized view"} ${object.identity.name}`,
      );
    }
  }
  return blockers;
}

function dependsOnTable(target: ObjectIdentity, table: string): boolean {
  if (target.kind === "table" && target.name === table) return true;
  return target.kind === "column" && target.parent.name === table;
}

/**
 * Reports whether two bounds are the same instant or the same literal.
 *
 * Time text is compared as an instant, so `+00` and an explicit zone offset match.
 *
 * @param left - Declared or read bound
 * @param right - The other bound
 * @returns `true` when a row in one would be in the other
 */
export function sameBound(left: PartitionBound, right: PartitionBound): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "default" && right.kind === "default") return true;
  if (left.kind === "hash" && right.kind === "hash") {
    return left.modulus === right.modulus && left.remainder === right.remainder;
  }
  if (left.kind === "list" && right.kind === "list") {
    return sameList(left.values, right.values);
  }
  if (left.kind === "range" && right.kind === "range") {
    return sameEndpoint(left.from, right.from) && sameEndpoint(left.to, right.to);
  }
  return false;
}

/**
 * Parses `pg_get_expr(relpartbound)` read in UTC.
 *
 * @param text - Bound expression, or an empty string
 * @returns The bound, or `undefined` when the text is not a partition bound
 */
export function parseBound(text: string): PartitionBound | undefined {
  const trimmed = text.trim();
  if (trimmed === "DEFAULT") return { kind: "default" };
  const hash = /WITH \(modulus (\d+), remainder (\d+)\)/i.exec(trimmed);
  if (hash?.[1] !== undefined && hash[2] !== undefined) {
    return { kind: "hash", modulus: Number(hash[1]), remainder: Number(hash[2]) };
  }
  const list = /IN \((.*)\)/i.exec(trimmed);
  if (list?.[1] !== undefined) {
    return { kind: "list", values: splitSqlList(list[1]).map(unquoteSql) };
  }
  const range = /FROM \((.*)\) TO \((.*)\)/i.exec(trimmed);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    return {
      kind: "range",
      from: canonicalEndpoint(unquoteSql(range[1])),
      to: canonicalEndpoint(unquoteSql(range[2])),
    };
  }
  return undefined;
}

/**
 * Days from `now` until the last range partition ends.
 *
 * @param children - Declared or live children
 * @param nowMs - Clock as epoch milliseconds
 * @returns Whole days, or `undefined` when no range child has a time bound
 */
export function daysLeft(children: readonly PartitionChild[], nowMs: number): number | undefined {
  let latest: ZoneInstant | undefined;
  for (const child of children) {
    if (child.bound.kind !== "range") continue;
    const end = parseInstant(child.bound.to);
    if (end === undefined) continue;
    if (latest === undefined || zones().Instant.compare(end, latest) > 0) latest = end;
  }
  if (latest === undefined) return undefined;
  const ms = latest.epochMilliseconds - nowMs;
  return Math.floor(ms / 86_400_000);
}

/**
 * Children whose upper bound is older than `keep`.
 *
 * @param children - Live children
 * @param rule - Declared keep window
 * @param nowMs - Clock as epoch milliseconds
 * @returns Suffixes maintain should detach or drop
 */
export function expiredSuffixes(
  children: readonly PartitionChild[],
  rule: PartitionRule | undefined,
  nowMs: number,
): readonly string[] {
  if (rule?.keepFor === undefined) return [];
  const span = parseSpan(rule.keepFor);
  if (span === undefined) return [];
  const now = zones().Instant.from(new Date(nowMs).toISOString());
  const cutoff = now.toZonedDateTimeISO("UTC").subtract(span).toInstant();
  const expired: string[] = [];
  for (const child of children) {
    if (child.bound.kind !== "range") continue;
    const end = parseInstant(child.bound.to);
    if (end !== undefined && zones().Instant.compare(end, cutoff) <= 0) expired.push(child.suffix);
  }
  return expired;
}

/**
 * Suggests `every` when range children are one width apart.
 *
 * @param children - Children in any order
 * @returns The unit, or `undefined` when the spacing is not even
 */
export function suggestEvery(children: readonly PartitionChild[]): string | undefined {
  const ranges = children.filter((child) => child.bound.kind === "range");
  if (ranges.length < 2) return undefined;
  const ordered = [...ranges].sort((left, right) => (left.suffix < right.suffix ? -1 : 1));
  const widths: number[] = [];
  for (const child of ordered) {
    if (child.bound.kind !== "range") continue;
    const from = parseInstant(child.bound.from);
    const to = parseInstant(child.bound.to);
    if (from === undefined || to === undefined) return undefined;
    widths.push(to.epochMilliseconds - from.epochMilliseconds);
  }
  const first = widths[0];
  if (first === undefined || widths.some((width) => width !== first)) return undefined;
  if (first === 86_400_000) return "day";
  if (first >= 28 * 86_400_000 && first <= 31 * 86_400_000) return "month";
  if (first >= 89 * 86_400_000 && first <= 92 * 86_400_000) return "quarter";
  if (first >= 365 * 86_400_000 && first <= 366 * 86_400_000) return "year";
  if (first === 7 * 86_400_000) return "week";
  return undefined;
}

/**
 * SQL boolean for one bound. Empty for a default partition.
 *
 * @param columns - SQL column names
 * @param dataTypes - Column types, parallel to `columns`
 * @param bound - Child bound
 * @returns The check expression, or `true` for a default
 */
export function boundCheck(
  columns: readonly string[],
  dataTypes: readonly string[],
  bound: PartitionBound,
  parent?: string,
): string {
  const column = columns[0];
  const dataType = dataTypes[0];
  if (column === undefined || dataType === undefined) return "true";
  const quoted = quoteIdent(column);
  if (bound.kind === "default") return "true";
  if (bound.kind === "list") {
    return `${quoted} in (${bound.values.map((value) => quoteLiteral(value)).join(", ")})`;
  }
  if (bound.kind === "hash") {
    const args = columns.map((name) => quoteIdent(name)).join(", ");
    const relation = parent ?? "tableoid";
    return `satisfies_hash_partition(${relation}, ${String(bound.modulus)}, ${String(bound.remainder)}, ${args})`;
  }
  const from = sqlLiteral(bound.from, dataType);
  const to = sqlLiteral(bound.to, dataType);
  return `${quoted} >= ${from} and ${quoted} < ${to}`;
}

/**
 * `FOR VALUES` clause for one bound.
 *
 * @param bound - Child bound
 * @param dataType - Key type, used to quote a range literal
 * @returns The clause, including `for values` or `default`
 */
export function boundSql(bound: PartitionBound, dataType: string): string {
  if (bound.kind === "default") return "default";
  if (bound.kind === "list") {
    return `for values in (${bound.values.map((value) => quoteLiteral(value)).join(", ")})`;
  }
  if (bound.kind === "hash") {
    return `for values with (modulus ${String(bound.modulus)}, remainder ${String(bound.remainder)})`;
  }
  return `for values from (${sqlLiteral(bound.from, dataType)}) to (${sqlLiteral(bound.to, dataType)})`;
}

/**
 * Child SQL name.
 *
 * @param table - Parent SQL name
 * @param suffix - Suffix after the underscore
 * @returns `{table}_{suffix}`
 */
export function childName(table: string, suffix: string): string {
  const name = `${table}_${suffix}`;
  if (name.length > 63) {
    refuse(
      `Partition name ${name} is longer than 63 characters.`,
      "Shorten the table name or the partition suffix.",
    );
  }
  return name;
}

function compileRule(
  table: string,
  option: Readonly<Record<string, unknown>>,
  column: PartitionColumnInfo,
  now: ZoneInstant,
): PartitionRule {
  const every = text(option.every, "partition.every");
  const from = text(option.from, "partition.from");
  const ahead = option.ahead;
  if (typeof ahead !== "number" || !Number.isInteger(ahead) || ahead < 0) {
    refuse(`Table ${table} partition.ahead must be a whole number.`, "Set ahead to 0 or more.");
  }
  const time = isTime(column.dataType);
  const numeric = isIntegerType(column.dataType);
  if (!time && !numeric) {
    refuse(
      `Table ${table} rule key ${column.sql} is ${column.dataType}. A rule needs timestamptz, date, or an integer.`,
      "Use an explicit partitions map for this type.",
    );
  }
  if (column.dataType === "timestamp" || column.dataType.startsWith("timestamp(")) {
    refuse(
      `Table ${table} key ${column.sql} is timestamp without a time zone.`,
      "Use timestamptz so every bound has an instant.",
    );
  }
  let at: string | undefined;
  if (time && column.dataType !== "date") {
    at = text(option.at, "partition.at");
    try {
      now.toZonedDateTimeISO(at);
    } catch {
      refuse(
        `Table ${table} partition.at ${at} is not an IANA time zone.`,
        "Use a zone such as Asia/Riyadh.",
      );
    }
  }
  if (time && !TIME_UNITS.has(every)) {
    refuse(
      `Table ${table} partition.every ${every} is not a time unit.`,
      "Use year, quarter, month, week, or day.",
    );
  }
  if (numeric && !/^\d+$/.test(every)) {
    refuse(
      `Table ${table} numeric every must be a positive integer.`,
      "Use a whole number of the key type.",
    );
  }
  const keep = option.keep;
  let keepFor: string | undefined;
  let keepThen: "detach" | "drop" | undefined;
  if (keep !== undefined) {
    const body = record(keep, "partition.keep");
    keepFor = text(body.for, "partition.keep.for");
    if (parseSpan(keepFor) === undefined && numericSpan(keepFor) === undefined) {
      refuse(
        `Table ${table} keep.for ${keepFor} is not a count and a unit.`,
        'Use a span such as "13 months".',
      );
    }
    keepThen = body.then === undefined ? "detach" : body.then === "drop" ? "drop" : undefined;
    if (keepThen === undefined) {
      refuse(
        `Table ${table} keep.then must be detach or drop.`,
        "Use detach, or drop with --allow-protected.",
      );
    }
  }
  return {
    every,
    from,
    ahead,
    ...(at !== undefined ? { at } : {}),
    ...(keepFor !== undefined ? { keepFor } : {}),
    ...(keepThen !== undefined ? { keepThen } : {}),
  };
}

function expandRule(
  table: string,
  column: PartitionColumnInfo,
  rule: PartitionRule,
  now: ZoneInstant,
): readonly PartitionChild[] {
  if (isIntegerType(column.dataType)) return expandNumeric(table, rule);
  return expandTime(table, column.dataType, rule, now);
}

function expandTime(
  table: string,
  dataType: string,
  rule: PartitionRule,
  now: ZoneInstant,
): readonly PartitionChild[] {
  const zone = rule.at ?? "UTC";
  const start = alignTime(rule.from, rule.every, zone, dataType);
  const current = alignInstant(now, rule.every, zone, dataType);
  const last =
    zones().PlainDate.compare(current, start) < 0
      ? addUnit(start, rule.every, Math.max(rule.ahead - 1, 0))
      : addUnit(current, rule.every, rule.ahead);
  const children: PartitionChild[] = [];
  let cursor = start;
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (zones().PlainDate.compare(cursor, last) > 0) break;
    const next = addUnit(cursor, rule.every, 1);
    children.push({
      suffix: timeSuffix(cursor, rule.every),
      bound: {
        kind: "range",
        from: endpoint(cursor, zone, dataType),
        to: endpoint(next, zone, dataType),
      },
    });
    cursor = next;
  }
  assertNoOverlap(table, children);
  return children;
}

function expandNumeric(table: string, rule: PartitionRule): readonly PartitionChild[] {
  const step = BigInt(rule.every);
  if (step <= 0n)
    refuse(`Table ${table} numeric every must be positive.`, "Use a positive integer.");
  let from: bigint;
  try {
    from = BigInt(rule.from);
  } catch {
    refuse(`Table ${table} partition.from must be an integer.`, "Use a whole number.");
  }
  const children: PartitionChild[] = [];
  const count = Math.max(rule.ahead, 1);
  for (let index = 0; index < count; index += 1) {
    const lower = from + step * BigInt(index);
    const upper = lower + step;
    children.push({
      suffix: lower < 0n ? `m${(-lower).toString()}` : lower.toString(),
      bound: { kind: "range", from: lower.toString(), to: upper.toString() },
    });
  }
  return children;
}

function compileExplicit(
  table: string,
  by: "range" | "list",
  columns: readonly PartitionColumnInfo[],
  partitions: unknown,
  at: string | undefined,
): readonly PartitionChild[] {
  if (partitions === undefined || typeof partitions !== "object" || partitions === null) {
    refuse(
      `Table ${table} needs a partitions map.`,
      "Set partitions: { name: { in } | { from, to } | { default: true } }.",
    );
  }
  const entries = Object.entries(partitions as Record<string, unknown>);
  if (entries.length === 0) {
    refuse(`Table ${table} partitions map is empty.`, "Name at least one partition.");
  }
  const children: PartitionChild[] = [];
  let defaults = 0;
  for (const [suffix, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(suffix)) {
      refuse(
        `Partition suffix ${suffix} is not an identifier.`,
        "Use letters, digits, and underscores.",
      );
    }
    const body = record(value, `partitions.${suffix}`);
    if (body.default === true) {
      defaults += 1;
      children.push({ suffix, bound: { kind: "default" } });
      continue;
    }
    if (Array.isArray(body.in)) {
      if (by !== "list") {
        refuse(`Table ${table} range partition ${suffix} uses in.`, "Use from and to for a range.");
      }
      const values = body.in.filter((item): item is string => typeof item === "string");
      if (values.length !== body.in.length || values.length === 0) {
        refuse(`Partition ${suffix} in must be a list of strings.`, "List the key values.");
      }
      children.push({ suffix, bound: { kind: "list", values } });
      continue;
    }
    if (typeof body.from === "string" && typeof body.to === "string") {
      if (by !== "range") {
        refuse(`Table ${table} list partition ${suffix} uses from and to.`, "Use in for a list.");
      }
      const column = columns[0];
      if (column === undefined) refuse(`Table ${table} needs a key.`, "Name the key.");
      const zone = at ?? "UTC";
      children.push({
        suffix,
        bound: {
          kind: "range",
          from: explicitEndpoint(body.from, column.dataType, zone),
          to: explicitEndpoint(body.to, column.dataType, zone),
        },
      });
      continue;
    }
    refuse(
      `Partition ${table}.${suffix} needs in, from and to, or default.`,
      "Use one of those three forms.",
    );
  }
  if (defaults > 1)
    refuse(`Table ${table} has more than one default partition.`, "Keep a single default.");
  assertNoOverlap(table, children);
  return children;
}

function explicitEndpoint(value: string, dataType: string, zone: string): string {
  if (isIntegerType(dataType)) return value;
  if (dataType === "date") return value;
  if (hasOffset(value)) return canonicalEndpoint(value);
  const local = value.length <= 10 ? `${value}T00:00:00` : value.replace(" ", "T");
  try {
    const instant = zones().PlainDateTime.from(local).toZonedDateTime(zone).toInstant();
    return formatInstant(instant);
  } catch {
    return value;
  }
}

function assertNoOverlap(table: string, children: readonly PartitionChild[]): void {
  const seen = new Set<string>();
  const ranges: { from: bigint | ZoneInstant; to: bigint | ZoneInstant; numeric: boolean }[] = [];
  for (const child of children) {
    if (child.bound.kind === "list") {
      for (const value of child.bound.values) {
        if (seen.has(value)) {
          refuse(
            `Table ${table} lists ${value} in more than one partition.`,
            "Keep each value in one partition.",
          );
        }
        seen.add(value);
      }
    }
    if (child.bound.kind === "range") {
      const fromInstant = parseInstant(child.bound.from);
      const toInstant = parseInstant(child.bound.to);
      if (fromInstant !== undefined && toInstant !== undefined) {
        ranges.push({ from: fromInstant, to: toInstant, numeric: false });
      } else if (/^-?\d+$/.test(child.bound.from) && /^-?\d+$/.test(child.bound.to)) {
        ranges.push({ from: BigInt(child.bound.from), to: BigInt(child.bound.to), numeric: true });
      }
    }
  }
  for (let index = 0; index < ranges.length; index += 1) {
    for (let other = index + 1; other < ranges.length; other += 1) {
      const left = ranges[index];
      const right = ranges[other];
      if (left === undefined || right === undefined || left.numeric !== right.numeric) continue;
      if (overlaps(left.from, left.to, right.from, right.to)) {
        refuse(
          `Table ${table} partition bounds overlap.`,
          "Make each range start where the previous one ends.",
        );
      }
    }
  }
}

function overlaps(
  from: bigint | ZoneInstant,
  to: bigint | ZoneInstant,
  otherFrom: bigint | ZoneInstant,
  otherTo: bigint | ZoneInstant,
): boolean {
  if (
    typeof from === "bigint" &&
    typeof to === "bigint" &&
    typeof otherFrom === "bigint" &&
    typeof otherTo === "bigint"
  ) {
    return from < otherTo && otherFrom < to;
  }
  if (isInstant(from) && isInstant(to) && isInstant(otherFrom) && isInstant(otherTo)) {
    return zones().Instant.compare(from, otherTo) < 0 && zones().Instant.compare(otherFrom, to) < 0;
  }
  return false;
}

function missingChildren(
  before: readonly PartitionChild[],
  after: readonly PartitionChild[],
): readonly PartitionChild[] {
  return after.filter((child) => !before.some((live) => sameBound(live.bound, child.bound)));
}

function isInstant(value: bigint | ZoneInstant): value is ZoneInstant {
  return typeof value !== "bigint";
}

function alignTime(from: string, _every: string, zone: string, dataType: string): ZoneDate {
  try {
    if (dataType === "date") return zones().PlainDate.from(from.slice(0, 10));
    if (hasOffset(from)) {
      return zones()
        .Instant.from(normalizeInstantText(from))
        .toZonedDateTimeISO(zone)
        .toPlainDate();
    }
    return zones().PlainDate.from(from.slice(0, 10));
  } catch {
    refuse(`partition.from ${from} is not a date in ${zone}.`, "Use YYYY-MM-DD.");
  }
}

function alignInstant(now: ZoneInstant, every: string, zone: string, dataType: string): ZoneDate {
  const local = now.toZonedDateTimeISO(zone).toPlainDate();
  if (dataType === "date" || every === "day") return local;
  if (every === "week") return local.subtract({ days: local.dayOfWeek - 1 });
  if (every === "month")
    return zones().PlainDate.from({ year: local.year, month: local.month, day: 1 });
  if (every === "quarter") {
    const month = local.month - ((local.month - 1) % 3);
    return zones().PlainDate.from({ year: local.year, month, day: 1 });
  }
  if (every === "year") return zones().PlainDate.from({ year: local.year, month: 1, day: 1 });
  return local;
}

function addUnit(date: ZoneDate, every: string, count: number): ZoneDate {
  if (every === "day") return date.add({ days: count });
  if (every === "week") return date.add({ weeks: count });
  if (every === "month") return date.add({ months: count });
  if (every === "quarter") return date.add({ months: count * 3 });
  if (every === "year") return date.add({ years: count });
  return date;
}

function timeSuffix(date: ZoneDate, every: string): string {
  const year = String(date.year);
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  if (every === "year") return year;
  if (every === "quarter") return `${year}_q${String(Math.floor((date.month - 1) / 3) + 1)}`;
  if (every === "month") return `${year}_${month}`;
  if (every === "week") {
    const week = isoWeek(date);
    return `${String(week.year)}_w${String(week.week).padStart(2, "0")}`;
  }
  return `${year}_${month}_${day}`;
}

function endpoint(date: ZoneDate, zone: string, dataType: string): string {
  if (dataType === "date") return date.toString();
  const instant = date.toPlainDateTime().toZonedDateTime(zone).toInstant();
  return formatInstant(instant);
}

function formatInstant(instant: ZoneInstant): string {
  const utc = instant.toZonedDateTimeISO("UTC");
  const plain = utc.toPlainDateTime();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${plain.year}-${pad(plain.month)}-${pad(plain.day)} ${pad(plain.hour)}:${pad(plain.minute)}:${pad(plain.second)}+00`;
}

function canonicalEndpoint(value: string): string {
  const instant = parseInstant(value);
  return instant === undefined ? value.trim() : formatInstant(instant);
}

function parseInstant(value: string): ZoneInstant | undefined {
  const text = normalizeInstantText(value);
  try {
    return zones().Instant.from(text);
  } catch {
    return undefined;
  }
}

function normalizeInstantText(value: string): string {
  let text = value.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(text)) text = `${text}:00`;
  if (/[+-]\d{2}\d{2}$/.test(text)) {
    text = `${text.slice(0, -2)}:${text.slice(-2)}`;
  }
  if (!text.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(text)) text = `${text}Z`;
  return text;
}

function sameEndpoint(left: string, right: string): boolean {
  if (left === right) return true;
  const a = parseInstant(left);
  const b = parseInstant(right);
  if (a !== undefined && b !== undefined) return a.epochMilliseconds === b.epochMilliseconds;
  return left.trim() === right.trim();
}

function parseSpan(value: string): ZoneSpan | undefined {
  const match = /^(\d+)\s+(year|years|quarter|quarters|month|months|week|weeks|day|days)$/.exec(
    value.trim(),
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const count = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith("year")) return { years: count };
  if (unit.startsWith("quarter")) return { months: count * 3 };
  if (unit.startsWith("month")) return { months: count };
  if (unit.startsWith("week")) return { weeks: count };
  return { days: count };
}

function numericSpan(value: string): bigint | undefined {
  const match = /^(\d+)$/.exec(value.trim());
  return match?.[1] === undefined ? undefined : BigInt(match[1]);
}

function sqlLiteral(value: string, dataType: string): string {
  if (isIntegerType(dataType)) return value;
  return quoteLiteral(value);
}

function isoWeek(date: ZoneDate): { readonly year: number; readonly week: number } {
  const thursday = date.add({ days: 4 - date.dayOfWeek });
  const jan4 = zones().PlainDate.from({ year: thursday.year, month: 1, day: 4 });
  const monday = jan4.subtract({ days: jan4.dayOfWeek - 1 });
  const days = thursday.since(monday, { largestUnit: "days" }).days;
  return { year: thursday.year, week: Math.floor(days / 7) + 1 };
}

function isTimestamptz(dataType: string): boolean {
  return (
    dataType === "timestamptz" ||
    dataType.startsWith("timestamptz(") ||
    dataType === "timestamp with time zone"
  );
}

function isTime(dataType: string): boolean {
  return (
    dataType === "date" ||
    isTimestamptz(dataType) ||
    dataType === "timestamp" ||
    dataType.startsWith("timestamp(")
  );
}

function isIntegerType(dataType: string): boolean {
  return (
    dataType === "int2" ||
    dataType === "int4" ||
    dataType === "int8" ||
    dataType === "integer" ||
    dataType === "bigint" ||
    dataType === "smallint"
  );
}

function hasOffset(value: string): boolean {
  const text = value.trim();
  return /[T ]/.test(text) && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text);
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function keyList(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(`${where} must be an object.`, "Pass an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse(`${where} must be text.`, "Pass a string.");
  }
  return value;
}

function splitSqlList(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function unquoteSql(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function refuse(message: string, fix: string): never {
  throw new OkmError("OKM1932", message, { kind: "invalid", fix: { summary: fix } });
}
