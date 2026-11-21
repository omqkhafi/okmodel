/**
 * Checks a fill expression on the target before the migration is written.
 *
 * One read-only transaction. The expression must return the column's type,
 * stay non-null on the empty rows, and pass the column's checks.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import type { RequiredChange } from "./plan.js";

const CONSTANT =
  /^(?:-?\d+(?:\.\d+)?|true|false|null|'(?:''|[^'])*')(?:\s*::\s*[\w." ]+(?:\[\])?)?$/i;

export async function checkExpression(
  url: string,
  schema: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<readonly string[]> {
  refuseShape(expression);
  const postgres = (await import("postgres")).default;
  const { driverUrl } = await import("./driver-url.js");
  const { OPTIONAL_CONNECT_SECONDS } = await import("./optional-read.js");
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: OPTIONAL_CONNECT_SECONDS,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const table = qualify(schema, change.table);
  const column = quoteIdent(change.column);
  const cast = typeSql(change.dataType);
  try {
    return await sql.begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '2s'");
      const lines: string[] = [];
      const trigger = await tx.unsafe<{ tgname: string }[]>(
        `select t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and not t.tgisinternal
       limit 1`,
        [schema, change.table],
      );
      const name = trigger[0]?.tgname;
      if (name !== undefined) {
        lines.push(
          `${change.table} has a trigger ${name}. A fill is an UPDATE, so it runs on the rows that were empty.`,
        );
      }
      try {
        await tx.unsafe(
          `select (${expression})::${cast} from (select 1) as okm_one left join ${table} on true limit 1`,
        );
      } catch (error) {
        throw expressionError(change, castMessage(error, change.dataType));
      }
      const width = /^(?:varchar|character varying)\((\d+)\)$/i.exec(change.dataType);
      if (width !== null) {
        const long = await tx.unsafe<{ c: string }[]>(
          `select count(*)::text as c from (select 1 from ${table} where ${column} is null and length((${expression})::text) > ${width[1] ?? "0"} limit 10001) as okm_n`,
        );
        if (Number(long[0]?.c ?? "0") > 0) {
          throw expressionError(change, `the value is longer than ${change.dataType}`);
        }
      }
      const run = (text: string): Promise<readonly Record<string, string | null>[]> =>
        tx.unsafe(text);
      if (isConstant(expression)) {
        refuseConstant(after, change);
        await assertForeignKey(run, schema, after, change, expression);
      }
      await assertChecks(run, table, column, after, change, expression);
      const nulls = await tx.unsafe<{ c: string }[]>(
        `select count(*)::text as c from (select 1 from ${table} where ${column} is null and (${expression}) is null limit 10001) as okm_n`,
      );
      const nullCount = Number(nulls[0]?.c ?? "0");
      if (nullCount > 0) {
        const how = nullCount > 10_000 ? "10,000 or more" : nullCount.toLocaleString("en-US");
        throw expressionError(change, `${expression} is null for ${how} rows`);
      }
      const key = primaryKeyName(after, change.table);
      if (key !== undefined) {
        const sample = await tx.unsafe<{ id: string | null; v: string | null }[]>(
          `select ${quoteIdent(key)}::text as id, (${expression})::text as v from ${table} where ${column} is null limit 1`,
        );
        const row = sample[0];
        lines.push(
          `I checked ${expression} against the target: it returns ${change.dataType} and is not null.`,
        );
        if (row?.id !== undefined && row.id !== null) {
          lines.push(`Example: ${change.table} ${row.id} would get ${row.v ?? ""}.`);
        }
      } else {
        lines.push(
          `I checked ${expression} against the target: it returns ${change.dataType} and is not null.`,
        );
      }
      return lines;
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

function refuseShape(expression: string): void {
  if (/[;]|--|\/\*|\*\//.test(expression)) {
    throw new OkmError("invalid", "The expression has a comment or a semicolon.", {
      fix: { summary: "Pass one expression. A statement is refused." },
    });
  }
  if (
    /^\s*(select|insert|update|delete|with|alter|drop|create|grant|revoke|copy|do|begin|commit)\b/i.test(
      expression,
    )
  ) {
    throw new OkmError("invalid", "The expression is a statement.", {
      fix: { summary: "Pass one expression, such as now() or a quoted column." },
    });
  }
}

function isConstant(expression: string): boolean {
  return CONSTANT.test(expression.trim());
}

function refuseConstant(after: Catalog, change: RequiredChange): void {
  const unique = after.objects.some(
    (object) =>
      object.kind === "constraint" &&
      (object.definition.constraintKind === "unique" ||
        object.definition.constraintKind === "primaryKey") &&
      object.identity.parent.name === change.table &&
      object.definition.columns.includes(change.column),
  );
  if (!unique) return;
  const key = primaryKeyName(after, change.table) ?? "id";
  throw new OkmError(
    "invalid",
    `A constant on unique ${change.table}.${change.column} would collide.`,
    { fix: { summary: `Use an expression such as 'tmp-' || ${key}.` } },
  );
}

async function assertForeignKey(
  sql: (text: string) => Promise<readonly Record<string, string | null>[]>,
  schema: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<void> {
  for (const object of after.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    if (object.identity.parent.name !== change.table) continue;
    const index = object.definition.columns.indexOf(change.column);
    if (index < 0 || object.definition.references === undefined) continue;
    const parent = object.definition.references.parent.name;
    const parentColumn = object.definition.references.columns[index];
    if (parentColumn === undefined) continue;
    const rows = await sql(
      `select exists(select 1 from ${qualify(schema, parent)} where ${quoteIdent(parentColumn)} = (${expression}))::text as ok`,
    );
    if (rows[0]?.ok === "true") continue;
    throw expressionError(change, `${expression} is not in ${parent}.${parentColumn}`);
  }
}

async function assertChecks(
  sql: (text: string) => Promise<readonly Record<string, string | null>[]>,
  table: string,
  column: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<void> {
  for (const object of after.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "check") continue;
    if (object.identity.parent.name !== change.table || object.definition.enforced === false)
      continue;
    if (!object.definition.columns.includes(change.column)) continue;
    const body = object.definition.expression ?? "";
    const quoted = quoteIdent(change.column);
    const substituted = body.includes(quoted)
      ? body.split(quoted).join(`(${expression})`)
      : body.replaceAll(new RegExp(`\\b${change.column}\\b`, "g"), `(${expression})`);
    const rows = await sql(
      `select count(*)::text as c from (select 1 from ${table} where ${column} is null and not (${substituted}) limit 10001) as okm_n`,
    );
    const n = Number(rows[0]?.c ?? "0");
    if (n > 0) throw expressionError(change, `${expression} does not pass ${object.identity.name}`);
  }
}

function primaryKeyName(after: Catalog, table: string): string | undefined {
  for (const object of after.objects) {
    if (
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.identity.parent.name === table
    ) {
      return object.definition.columns[0];
    }
  }
  return undefined;
}

function typeSql(dataType: string): string {
  if (/^[a-z_][\w$]*(\([^)]*\))?(\[\])*$/.test(dataType)) return dataType;
  return quoteIdent(dataType);
}

function expressionError(change: RequiredChange, reason: string): OkmError {
  return new OkmError("invalid", `${change.table}.${change.column}: ${reason}.`, {
    fix: { summary: "Pass an expression that yields a non-null value of the column's type." },
  });
}

function castMessage(error: unknown, dataType: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("22001") || message.includes("value too long"))
    return `the value is longer than ${dataType}`;
  if (message.includes("23514") || message.includes("check constraint"))
    return "the value does not pass a check";
  return `it does not return ${dataType}`;
}
