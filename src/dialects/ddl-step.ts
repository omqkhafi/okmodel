/**
 * One physical plan step.
 *
 * The planner and the Postgres lowering both use this so a statement
 * carries the same class, kind, and table list.
 */

import type { StepKind } from "./step-class.js";
import { classOf } from "./step-class.js";
import type { DdlStep, LoweredStep } from "./ddl.js";

const TABLE_PREFIX =
  /\b(?:create|alter|drop)\s+table(?:\s+if\s+exists)?\s+|\bupdate\s+|\binsert\s+into\s+|\breferences\s+|\bon\s+table\s+|\bon\s+/gi;

/**
 * Builds one physical step.
 *
 * @param sql - Statement text, without a trailing semicolon
 * @param kind - Planner operation. The class comes from this kind
 * @param action - `ddl` or `backfill`
 * @param lock - Lock comment
 * @param transactional - Whether the step can share a transaction
 * @param extraTables - Tables the SQL does not name
 * @returns The step, with the class of `kind`
 */
export function ddlStep(
  sql: string,
  kind: StepKind,
  action: DdlStep["action"],
  lock: string,
  transactional = true,
  extraTables?: readonly string[],
): LoweredStep {
  const tables = touchedTables(sql, lock, extraTables);
  return {
    sql,
    kind,
    class: classOf(kind),
    action,
    lock,
    transactional,
    ...(tables.length > 0 ? { tables } : {}),
  };
}

/**
 * Tables named by a statement or by a lock comment.
 *
 * A schema-qualified identifier after a table keyword counts. A following dot
 * is a column (`"public"."tasks"."id"`) and is skipped. `rename to` is not a
 * keyword here, so the new name of a rename is not treated as a second table.
 *
 * @param sql - Statement text
 * @param lock - Lock comment, which may name a second relation
 * @param extra - Tables the SQL does not name, such as the parent of a dropped index
 * @returns Names in first-seen order, without duplicates
 */
function touchedTables(
  sql: string,
  lock: string,
  extra: readonly string[] | undefined,
): readonly string[] {
  const names: string[] = [];
  const text = `${sql}\n${lock}`;
  TABLE_PREFIX.lastIndex = 0;
  for (let match = TABLE_PREFIX.exec(text); match !== null; match = TABLE_PREFIX.exec(text)) {
    const found = readQualified(text, match.index + match[0].length);
    if (found !== undefined) pushTable(names, found.name);
  }
  for (const name of extra ?? []) pushTable(names, name);
  return names;
}

function pushTable(names: string[], name: string): void {
  if (!names.includes(name)) names.push(name);
}

function readQualified(
  text: string,
  start: number,
): { readonly name: string; readonly end: number } | undefined {
  const schema = readIdent(text, start);
  if (schema === undefined) return undefined;
  if (text[schema.end] !== "." || text[schema.end + 1] !== '"') return undefined;
  const name = readIdent(text, schema.end + 1);
  if (name === undefined || text[name.end] === ".") return undefined;
  return name;
}

function readIdent(
  text: string,
  start: number,
): { readonly name: string; readonly end: number } | undefined {
  if (text[start] !== '"') return undefined;
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      if (text[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { name: value, end: index + 1 };
    }
    value += char ?? "";
    index += 1;
  }
  return undefined;
}
