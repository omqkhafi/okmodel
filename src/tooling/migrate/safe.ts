/**
 * Safe DDL for a table that already exists (D193).
 *
 * A new table keeps the plain statements from `ddl.ts`. These shapes are only
 * for a table in the before-catalog: `NOT VALID` plus `VALIDATE`, a volatile
 * default split from column creation, and a unique or primary key built from
 * a concurrent unique index. Index create and drop are lowered by the dialect.
 *
 * The volatile-default fill is a backfill: one idempotent `UPDATE` per batch,
 * limited to rows where the new column is still null (D195).
 */

import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
} from "../../contracts/catalog/types.js";
import { ddlStep } from "../../dialects/ddl-step.js";
import { columnType, createObjectSql, qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { notNullSteps } from "../../dialects/pg/table-safe.js";
import { nullFillUpdate, primaryKeyColumns, type BackfillSpec } from "./backfill.js";
import type { StepKind } from "./classify.js";

/** One statement the planner emits instead of the plain form. */
export type SafeStep = {
  readonly sql: string;
  readonly kind: StepKind;
  readonly action: "ddl" | "backfill";
  readonly lock: string;
  readonly transactional: boolean;
  /** Set on the volatile-default fill. The statement is one batch. */
  readonly backfill?: BackfillSpec;
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
 * @param batchSize - Rows per batch written on a volatile-default fill
 * @returns The replacement steps, or `undefined` to keep the plain statement
 */
export function stepsForExistingTable(
  object: CatalogObject,
  schema: string,
  catalogs: readonly Catalog[],
  batchSize: number,
): readonly SafeStep[] | undefined {
  if (object.kind === "constraint") return constraintSteps(object, schema);
  if (object.kind === "column" && volatileDefault(object.definition.defaultExpression, catalogs)) {
    return volatileColumnSteps(object, schema, catalogs, batchSize);
  }
  return undefined;
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

function constraintSteps(object: ConstraintObject, schema: string): readonly SafeStep[] {
  const kind = object.definition.constraintKind;
  if (kind === "unique" || kind === "primaryKey") return usingIndexSteps(object, schema);
  return notValidSteps(object, schema);
}

function notValidSteps(object: ConstraintObject, schema: string): readonly SafeStep[] {
  const plain = createObjectSql(object, schema);
  if (plain === undefined) return [];
  if (object.definition.enforced === false) {
    return [
      { sql: plain, kind: "add-constraint", action: "ddl", lock: ACCESS, transactional: true },
    ];
  }
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
  batchSize: number,
): readonly SafeStep[] {
  const tableName = column.identity.parent.name;
  const table = qualify(schema, tableName);
  const name = quoteIdent(column.identity.name);
  const collate =
    column.definition.collation === undefined
      ? ""
      : ` collate ${quoteIdent(column.definition.collation)}`;
  const expression = column.definition.defaultExpression ?? "";
  const key = primaryKeyColumns(catalogs, tableName);
  const filled = nullFillUpdate(table, name, expression, key, batchSize);
  const backfill: BackfillSpec = filled.backfill;
  const steps: SafeStep[] = [
    {
      sql: `alter table ${table} add column ${name} ${columnType(column, schema)}${collate}`,
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
      sql: filled.sql,
      kind: "backfill-expand",
      action: "backfill",
      lock: ROW,
      transactional: false,
      backfill,
    },
  ];
  if (!column.definition.nullable) {
    steps.push(...notNullSteps(column, schema, "add-column", catalogs));
  }
  return steps;
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

/** Drops a trailing ` NOT VALID` marker the introspector appends. */
export function bareCheck(expression: string | undefined): string {
  if (expression === undefined) return "";
  const marker = " NOT VALID";
  return expression.endsWith(marker) ? expression.slice(0, -marker.length) : expression;
}
/**
 * Changes only deferrability, or only when the constraint is checked.
 *
 * One `ALTER CONSTRAINT` statement. No drop and no revalidation.
 *
 * @param changes - Constraints whose other fields already match
 * @param schema - Schema name
 * @returns One step per constraint
 */
export function deferrableSteps(changes: readonly ConstraintObject[], schema: string) {
  const steps: ReturnType<typeof ddlStep>[] = [];
  for (const object of changes) {
    const table = qualify(schema, object.identity.parent.name);
    const name = quoteIdent(object.identity.name);
    const clause = object.definition.deferrable
      ? `deferrable initially ${object.definition.initially}`
      : "not deferrable";
    steps.push(
      ddlStep(
        `alter table ${table} alter constraint ${name} ${clause}`,
        "alter-constraint",
        "ddl",
        ACCESS,
      ),
    );
  }
  return steps;
}

/** `ALTER CONSTRAINT` on 19. Older servers drop the check and add it again. */
export function enforcementSteps(
  changes: readonly { readonly after: ConstraintObject }[],
  schema: string,
  postgres: number | undefined,
) {
  const steps: ReturnType<typeof ddlStep>[] = [];
  const major = postgres ?? 0;
  for (const change of changes) {
    const table = qualify(schema, change.after.identity.parent.name);
    const name = quoteIdent(change.after.identity.name);
    const off = change.after.definition.enforced === false;
    if (major >= 19) {
      steps.push(
        ddlStep(
          `alter table ${table} alter constraint ${name} ${off ? "not enforced" : "enforced"}`,
          "add-constraint",
          "ddl",
          ACCESS,
          true,
        ),
      );
      continue;
    }
    const expression = bareCheck(change.after.definition.expression);
    const note =
      "-- PostgreSQL 18 cannot ALTER CONSTRAINT enforcement, so this drops the check and adds it again.\n";
    steps.push(
      ddlStep(
        `${note}alter table ${table} drop constraint ${name}`,
        "drop-constraint",
        "ddl",
        ACCESS,
        true,
      ),
    );
    steps.push(
      ddlStep(
        `alter table ${table} add constraint ${name} check (${expression})${off ? " not enforced" : " not valid"}`,
        "add-constraint",
        "ddl",
        ACCESS,
        true,
      ),
    );
    if (!off) {
      steps.push(
        ddlStep(
          `alter table ${table} validate constraint ${name}`,
          "validate-constraint",
          "ddl",
          SHARE_UPDATE,
          true,
        ),
      );
    }
  }
  return steps;
}
