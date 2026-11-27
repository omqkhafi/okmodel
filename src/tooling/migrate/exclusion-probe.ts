/**
 * Read-only checks that run before an exclusion constraint takes its lock.
 *
 * An overlap stops with OKM1922 and "Nothing was changed." A partitioned
 * table whose exclusion omits a partition column stops before SQL, because
 * PostgreSQL returns 0A000 and there is no `NOT VALID` form.
 */

import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { refuseGeneratedProbe } from "./data-probe.js";

const EXCLUDE = /\bexclude using gist\s*\(/i;

/**
 * Runs the overlap pre-check and the partition-column check.
 *
 * A statement that is not `EXCLUDE USING gist` returns immediately, so a
 * hand-written `EXCLUDE USING btree` weight fixture is left alone.
 *
 * @param connection - The reserved apply connection, inside the migration transaction
 * @param sql - The step text
 */
export async function guardExclusion(connection: DriverConnection, sql: string): Promise<void> {
  if (!/\badd constraint\b/i.test(sql) || !EXCLUDE.test(sql)) return;
  const parsed = parseExclude(sql);
  if (parsed === undefined) return;
  await assertPartitionColumns(connection, parsed);
  const probe = overlapSql(parsed);
  let count = 0;
  try {
    const result = await connection.execute(probe);
    count = Number(result.rows[0]?.[0] ?? 0);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  refuseGeneratedProbe(
    count,
    `exclusion ${parsed.name} (${String(count)} overlapping pairs, scan capped at 10001)`,
  );
}

type ParsedExclude = {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly elements: readonly { readonly target: string; readonly operator: string }[];
  readonly where?: string;
};

function parseExclude(sql: string): ParsedExclude | undefined {
  const tableAt = sql.toLowerCase().indexOf("alter table ");
  if (tableAt === -1) return undefined;
  const after = sql.slice(tableAt + "alter table ".length).trimStart();
  const qualified = readQualified(after);
  if (qualified === undefined) return undefined;
  const nameMatch = /add constraint\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/i.exec(sql);
  if (nameMatch?.[1] === undefined) return undefined;
  const open = sql.toLowerCase().indexOf("exclude using gist (");
  const start = open === -1 ? -1 : sql.indexOf("(", open);
  if (start === -1) return undefined;
  const end = matching(sql, start);
  if (end === undefined) return undefined;
  const elements: { target: string; operator: string }[] = [];
  for (const part of splitTop(sql.slice(start + 1, end))) {
    const withAt = part.toLowerCase().lastIndexOf(" with ");
    if (withAt === -1) return undefined;
    elements.push({
      target: part.slice(0, withAt).trim(),
      operator: part.slice(withAt + " with ".length).trim(),
    });
  }
  if (elements.length === 0) return undefined;
  const whereAt = sql.toLowerCase().indexOf(" where (", end);
  const where = whereAt === -1 ? undefined : unwrap(sql.slice(whereAt + " where ".length));
  return {
    schema: qualified.schema,
    table: qualified.table,
    name: unquote(nameMatch[1]),
    elements,
    ...(where !== undefined ? { where } : {}),
  };
}

function overlapSql(parsed: ParsedExclude): string {
  const table = `${quote(parsed.schema)}.${quote(parsed.table)}`;
  const terms = parsed.elements.map(
    (element) =>
      `${qualify(element.target, "a")} ${element.operator} ${qualify(element.target, "b")}`,
  );
  if (parsed.where !== undefined) {
    terms.push(`(${qualify(parsed.where, "a")})`);
    terms.push(`(${qualify(parsed.where, "b")})`);
  }
  return `select count(*) from (select 1 from ${table} a join ${table} b on a.ctid < b.ctid and ${terms.join(" and ")} limit 10001) s`;
}

async function assertPartitionColumns(
  connection: DriverConnection,
  parsed: ParsedExclude,
): Promise<void> {
  let keys: string[] = [];
  try {
    const result = await connection.execute(
      `select a.attname from pg_partitioned_table p join pg_class c on c.oid = p.partrelid join pg_namespace n on n.oid = c.relnamespace join unnest(p.partattrs) as key(attnum) on true join pg_attribute a on a.attrelid = c.oid and a.attnum = key.attnum where n.nspname = $1 and c.relname = $2`,
      [parsed.schema, parsed.table],
    );
    keys = result.rows.map((row) => String(row[0]));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (keys.length === 0) return;
  const present = parsed.elements.map((element) => unquote(element.target));
  const missingKey = keys.find((key) => !present.includes(key));
  if (missingKey === undefined) return;
  throw new OkmError(
    "OKM1020",
    `Exclusion ${parsed.name} on partitioned table ${parsed.table} must include partition column ${missingKey}. PostgreSQL returns 0A000 and there is no NOT VALID form. Nothing was changed.`,
    { fix: { summary: "Add every partition column to the exclusion, each with eq." } },
  );
}

function qualify(expression: string, alias: string): string {
  return expression.replace(/"(?:[^"]|"")+"/g, (ident) => `${alias}.${ident}`);
}

function readQualified(
  text: string,
): { readonly schema: string; readonly table: string } | undefined {
  const schema = readIdent(text);
  if (schema === undefined) return undefined;
  const rest = text.slice(schema.length).trimStart();
  if (!rest.startsWith(".")) return { schema: "public", table: unquote(schema) };
  const table = readIdent(rest.slice(1).trimStart());
  if (table === undefined) return undefined;
  return { schema: unquote(schema), table: unquote(table) };
}

function readIdent(text: string): string | undefined {
  if (text.startsWith('"')) {
    let index = 1;
    while (index < text.length) {
      if (text[index] === '"' && text[index + 1] === '"') {
        index += 2;
        continue;
      }
      if (text[index] === '"') return text.slice(0, index + 1);
      index += 1;
    }
    return undefined;
  }
  const match = /^[A-Za-z_][\w$]*/.exec(text);
  return match?.[0];
}

function matching(text: string, open: number): number | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function unwrap(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(")) return undefined;
  const end = matching(trimmed, 0);
  return end === undefined ? undefined : trimmed.slice(1, end);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}
