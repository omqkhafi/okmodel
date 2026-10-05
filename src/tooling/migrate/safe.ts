/**
 * Safe DDL for a table that already exists (D193).
 *
 * A new table keeps the plain statements from `ddl.ts`. These shapes are only
 * for a table in the before-catalog: concurrent indexes, `NOT VALID` plus
 * `VALIDATE`, `SET NOT NULL` through a validated check, a volatile default
 * split from column creation, and a unique or primary key built from a
 * concurrent unique index.
 *
 * The volatile-default fill is one `UPDATE`. Batching and resume inside that
 * statement are P52.
 */

import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  IndexObject,
} from "../../contracts/catalog/types.js";
import { createObjectSql, qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import type { StepKind } from "./classify.js";

/** One statement the planner emits instead of the plain form. */
export type SafeStep = {
  readonly sql: string;
  readonly kind: StepKind;
  readonly action: "ddl" | "backfill";
  readonly lock: string;
  readonly transactional: boolean;
};

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";
const ROW = "ROW EXCLUSIVE";

/**
 * Built-in functions Postgres marks volatile.
 *
 * `gen_random_uuid()` and `uuidv7()` are not rows in the author catalog.
 * A function the catalog stores is read from that row instead.
 */
const VOLATILE_BUILTIN: ReadonlySet<string> = new Set([
  "clock_timestamp",
  "gen_random_uuid",
  "nextval",
  "random",
  "random_normal",
  "setval",
  "timeofday",
  "uuidv7",
]);

/**
 * Built-in functions Postgres marks stable.
 *
 * `now()` is `transaction_timestamp()`. A stable or constant default stays a
 * plain `ADD COLUMN`.
 */
const STABLE_BUILTIN: ReadonlySet<string> = new Set([
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "localtime",
  "localtimestamp",
  "now",
  "session_user",
  "statement_timestamp",
  "transaction_timestamp",
]);

/**
 * Safe steps for one object on a table that already exists.
 *
 * Returns `undefined` when the plain statement is already safe: a stable or
 * constant column default, or an object this rewrite does not cover.
 *
 * @param object - Object the plan is creating
 * @param schema - Concrete schema name
 * @param catalogs - Before and after catalogs, for volatility and name clashes
 * @returns The replacement steps, or `undefined` to keep the plain statement
 */
export function stepsForExistingTable(
  object: CatalogObject,
  schema: string,
  catalogs: readonly Catalog[],
): readonly SafeStep[] | undefined {
  if (object.kind === "index") return [concurrentIndexStep(object, schema)];
  if (object.kind === "constraint") return constraintSteps(object, schema);
  if (object.kind === "column" && volatileDefault(object.definition.defaultExpression, catalogs)) {
    return volatileColumnSteps(object, schema, catalogs);
  }
  return undefined;
}

/**
 * `SET NOT NULL` through a validated check (Postgres 12+, always on the floor of 15).
 *
 * Postgres skips the table scan when a validated `CHECK (col IS NOT NULL)`
 * already exists. The temporary check is dropped after `SET NOT NULL`.
 *
 * @param column - Column that must become `NOT NULL`
 * @param schema - Concrete schema name
 * @param setKind - `set-not-null` when the column already existed; `add-column` when this finishes a new column and the plan stays expand
 * @param catalogs - Catalogs whose constraint names the temporary check must not reuse
 * @returns Add `NOT VALID`, validate, set not null, drop the check
 */
export function notNullSteps(
  column: ColumnObject,
  schema: string,
  setKind: "set-not-null" | "add-column",
  catalogs: readonly Catalog[],
): readonly SafeStep[] {
  const tableName = column.identity.parent.name;
  const columnName = column.identity.name;
  const table = qualify(schema, tableName);
  const quotedColumn = quoteIdent(columnName);
  const constraint = quoteIdent(notNullConstraintName(tableName, columnName, catalogs));
  return [
    {
      sql: `alter table ${table} add constraint ${constraint} check (${quotedColumn} is not null) not valid`,
      kind: "add-constraint",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `alter table ${table} validate constraint ${constraint}`,
      kind: "validate-constraint",
      action: "ddl",
      lock: SHARE_UPDATE,
      transactional: true,
    },
    {
      sql: `alter table ${table} alter column ${quotedColumn} set not null`,
      kind: setKind,
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `alter table ${table} drop constraint ${constraint}`,
      kind: "drop-not-null-check",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
  ];
}

/**
 * Inserts `CONCURRENTLY` into a `CREATE INDEX` statement.
 *
 * @param sql - Plain `create index` or `create unique index` from `ddl.ts`
 * @returns The same statement, concurrent
 */
export function concurrentIndexSql(sql: string): string {
  const unique = "create unique index ";
  const plain = "create index ";
  if (sql.startsWith(unique)) return `create unique index concurrently ${sql.slice(unique.length)}`;
  if (sql.startsWith(plain)) return `create index concurrently ${sql.slice(plain.length)}`;
  return sql;
}

/**
 * Inserts `CONCURRENTLY` into a `DROP INDEX` statement.
 *
 * @param sql - Plain `drop index` from `ddl.ts`
 * @returns The same statement, concurrent
 */
export function concurrentDropIndexSql(sql: string): string {
  const prefix = "drop index ";
  if (!sql.startsWith(prefix)) return sql;
  return `drop index concurrently ${sql.slice(prefix.length)}`;
}

/**
 * Reports whether a default expression is volatile.
 *
 * A constant has no call. `now()` and the other stable builtins stay plain.
 * `gen_random_uuid()`, `uuidv7()`, and any other call the catalog marks
 * volatile are split. A call the catalog does not know is left plain.
 *
 * @param expression - Column `defaultExpression`, when the column has one
 * @param catalogs - Catalogs that may hold the called function
 * @returns `true` when adding the column with this default would rewrite existing rows
 */
export function volatileDefault(
  expression: string | undefined,
  catalogs: readonly Catalog[],
): boolean {
  if (expression === undefined) return false;
  const known = catalogVolatility(catalogs);
  for (const name of functionCalls(expression)) {
    const lower = name.toLowerCase();
    if (VOLATILE_BUILTIN.has(lower)) return true;
    if (STABLE_BUILTIN.has(lower)) continue;
    if (known.get(lower) === "volatile") return true;
  }
  return false;
}

function concurrentIndexStep(object: IndexObject, schema: string): SafeStep {
  const plain = createObjectSql(object, schema) ?? "";
  return {
    sql: concurrentIndexSql(plain),
    kind: "create-index",
    action: "ddl",
    lock: SHARE_UPDATE,
    transactional: false,
  };
}

function constraintSteps(object: ConstraintObject, schema: string): readonly SafeStep[] {
  const kind = object.definition.constraintKind;
  if (kind === "unique" || kind === "primaryKey") return usingIndexSteps(object, schema);
  return notValidSteps(object, schema);
}

function notValidSteps(object: ConstraintObject, schema: string): readonly SafeStep[] {
  const plain = createObjectSql(object, schema);
  if (plain === undefined) return [];
  const table = qualify(schema, object.identity.parent.name);
  const name = quoteIdent(object.identity.name);
  const referenced = object.definition.references;
  const referencedLock =
    referenced === undefined ? undefined : qualify(schema, referenced.parent.name);
  return [
    {
      sql: `${plain} not valid`,
      kind: "add-constraint",
      action: "ddl",
      lock:
        referencedLock === undefined
          ? ACCESS
          : `${ACCESS}; SHARE ROW EXCLUSIVE on ${referencedLock}`,
      transactional: true,
    },
    {
      sql: `alter table ${table} validate constraint ${name}`,
      kind: "validate-constraint",
      action: "ddl",
      lock:
        referencedLock === undefined
          ? SHARE_UPDATE
          : `${SHARE_UPDATE}; ROW SHARE on ${referencedLock}`,
      transactional: true,
    },
  ];
}

function usingIndexSteps(object: ConstraintObject, schema: string): readonly SafeStep[] {
  const table = qualify(schema, object.identity.parent.name);
  const name = quoteIdent(object.identity.name);
  const columns = object.definition.columns.map((column) => quoteIdent(column)).join(", ");
  const nulls = object.definition.nullsNotDistinct ? " nulls not distinct" : "";
  const verb = object.definition.constraintKind === "primaryKey" ? "primary key" : "unique";
  const defer = object.definition.deferrable
    ? ` deferrable initially ${object.definition.initially}`
    : "";
  return [
    {
      sql: `create unique index concurrently ${name} on ${table} (${columns})${nulls}`,
      kind: "create-index",
      action: "ddl",
      lock: SHARE_UPDATE,
      transactional: false,
    },
    {
      sql: `alter table ${table} add constraint ${name} ${verb} using index ${name}${defer}`,
      kind: "add-constraint",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
  ];
}

function volatileColumnSteps(
  column: ColumnObject,
  schema: string,
  catalogs: readonly Catalog[],
): readonly SafeStep[] {
  const table = qualify(schema, column.identity.parent.name);
  const name = quoteIdent(column.identity.name);
  const collate =
    column.definition.collation === undefined
      ? ""
      : ` collate ${quoteIdent(column.definition.collation)}`;
  const expression = column.definition.defaultExpression ?? "";
  const steps: SafeStep[] = [
    {
      sql: `alter table ${table} add column ${name} ${column.definition.dataType}${collate}`,
      kind: "add-column",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `alter table ${table} alter column ${name} set default ${expression}`,
      kind: "set-default",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `update ${table} set ${name} = ${expression} where ${name} is null`,
      kind: "backfill-expand",
      action: "backfill",
      lock: ROW,
      transactional: true,
    },
  ];
  if (!column.definition.nullable) {
    steps.push(...notNullSteps(column, schema, "add-column", catalogs));
  }
  return steps;
}

function notNullConstraintName(
  table: string,
  column: string,
  catalogs: readonly Catalog[],
): string {
  const taken = new Set<string>();
  for (const source of catalogs) {
    for (const object of source.objects) {
      if (object.kind === "constraint" || object.kind === "index") taken.add(object.identity.name);
    }
  }
  const base = fitIdentifier(`${table}_${column}_notnull`);
  if (!taken.has(base)) return base;
  return fitIdentifier(`${table}_${column}_notnull_okm`);
}

function catalogVolatility(
  catalogs: readonly Catalog[],
): ReadonlyMap<string, "volatile" | "stable" | "immutable"> {
  const map = new Map<string, "volatile" | "stable" | "immutable">();
  for (const source of catalogs) {
    for (const object of source.objects) {
      if (object.kind !== "function") continue;
      const name = object.identity.name.toLowerCase();
      const next = object.definition.volatility;
      const current = map.get(name);
      if (current === "volatile" || next === "volatile") map.set(name, "volatile");
      else if (current === undefined) map.set(name, next);
    }
  }
  return map;
}

/**
 * Function names called in an expression.
 *
 * Text inside single quotes is not a call. `schema.name(` keeps `name`.
 *
 * @param expression - SQL expression
 * @returns Names in call order, with their original spelling
 */
function functionCalls(expression: string): readonly string[] {
  const names: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === "'") {
      index += 1;
      while (index < expression.length) {
        if (expression[index] === "'" && expression[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (expression[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char !== undefined && /[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < expression.length && /[\w$]/.test(expression[index] ?? "")) index += 1;
      let name = expression.slice(start, index);
      if (expression[index] === ".") {
        index += 1;
        const qualifier = index;
        while (index < expression.length && /[\w$]/.test(expression[index] ?? "")) index += 1;
        name = expression.slice(qualifier, index);
      }
      while (expression[index] === " ") index += 1;
      if (expression[index] === "(") names.push(name);
      continue;
    }
    index += 1;
  }
  return names;
}
