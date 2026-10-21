/**
 * `.okm/raw.lock.json` and `.okm/raw.d.ts`.
 *
 * The lock is version 1, sorted by statement hash, with stable key order.
 * The declaration augments `okmodel/pg` `RawStatements`, keyed by the exact
 * SQL literal.
 */

import { OkmError } from "../../contracts/error.js";
import { typescriptForPgType, type PgTypescriptCodecs } from "../../dialects/pg/emit.js";
import {
  parseRawLockValue,
  staleRaw,
  type RawLock,
  type RawLockStatement,
} from "../../dialects/pg/raw-lock.js";
import { errorDoc } from "../errors/registry.js";
import type { RawCall } from "./scan.js";

export type {
  RawLock,
  RawLockColumn,
  RawLockParam,
  RawLockStatement,
} from "../../dialects/pg/raw-lock.js";

/**
 * Pretty JSON for the lock. Keys are in a fixed order and hashes are sorted.
 *
 * @param lock - Lock to write
 * @returns JSON ending in a newline
 */
export function renderLock(lock: RawLock): string {
  const statements: Record<string, unknown> = {};
  for (const hash of Object.keys(lock.statements).sort()) {
    const statement = lock.statements[hash];
    if (statement === undefined) continue;
    statements[hash] = statementJson(statement);
  }
  return `${JSON.stringify(
    {
      version: lock.version,
      dialect: lock.dialect,
      catalogHash: lock.catalogHash,
      statements,
    },
    null,
    2,
  )}\n`;
}

/**
 * Reads a lock file. A value that is not version 1 is refused.
 *
 * @param text - File text
 * @returns The lock
 * @throws OkmError OKM1601 when the file is not a lock
 */
export function parseLock(text: string): RawLock {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw staleRaw();
  }
  const parsed = parseRawLockValue(value);
  if (parsed === undefined) throw staleRaw();
  return parsed;
}

/**
 * Codes for statements that are in the source but not the lock.
 *
 * @param discovered - Hashes of static calls
 * @param locked - Hashes in the lock. Omitted when the file is absent
 * @returns `OKM1604` when a call is missing, otherwise an empty list
 */
export function missingLockCodes(
  discovered: readonly string[],
  locked: readonly string[] | undefined,
): readonly string[] {
  if (discovered.length === 0) return [];
  const have = new Set(locked ?? []);
  return discovered.some((hash) => !have.has(hash)) ? ["OKM1604"] : [];
}

/**
 * Codes for lock entries the source no longer calls.
 *
 * @param discovered - Hashes of static calls
 * @param locked - Hashes in the lock
 * @returns `OKM1605` when an entry is stale, otherwise an empty list
 */
export function staleLockCodes(
  discovered: readonly string[],
  locked: readonly string[],
): readonly string[] {
  const have = new Set(discovered);
  return locked.some((hash) => !have.has(hash)) ? ["OKM1605"] : [];
}

/**
 * Throws OKM1604 when a discovered statement is absent from the lock.
 *
 * @param discovered - Hashes of static calls
 * @param locked - Hashes in the lock, or `undefined` when the file is absent
 */
export function assertLocked(
  discovered: readonly string[],
  locked: readonly string[] | undefined,
): void {
  if (missingLockCodes(discovered, locked).length === 0) return;
  const doc = errorDoc("OKM1604");
  throw new OkmError(
    doc?.code ?? "OKM1604",
    doc?.summary ?? "A raw statement is not in the lock.",
    {
      fix: { summary: doc?.fix ?? "Run okm raw sync and commit the lock." },
    },
  );
}

/**
 * Throws OKM1601 when two signatures differ.
 *
 * @param stored - Signature in the lock
 * @param described - Signature just described
 */
export function assertSignature(stored: RawLockStatement, described: RawLockStatement): void {
  if (statementJsonText(stored) === statementJsonText(described)) return;
  throw staleRaw();
}

/**
 * Module augmentation keyed by the exact SQL literal.
 *
 * Two literals that normalise to one statement share that statement's types.
 * A type with no codec is `string`.
 *
 * @param calls - Discovered calls
 * @param lock - Described statements
 * @param codecs - Schema codecs for `bigint` and `numeric`
 * @returns Declaration text ending in a newline
 */
export function renderRawTypes(
  calls: readonly RawCall[],
  lock: RawLock,
  codecs?: PgTypescriptCodecs,
): string {
  const entries: { readonly exact: string; readonly statement: RawLockStatement }[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.exact)) continue;
    seen.add(call.exact);
    const statement = lock.statements[call.key];
    if (statement === undefined) continue;
    entries.push({ exact: call.exact, statement });
  }
  entries.sort((left, right) => (left.exact < right.exact ? -1 : left.exact > right.exact ? 1 : 0));
  const body = entries
    .map(
      (entry) =>
        `    ${JSON.stringify(entry.exact)}: {\n      readonly params: readonly [${paramsOf(entry.statement, codecs)}];\n      readonly row: { ${rowOf(entry.statement, codecs)} };\n      readonly kind: ${JSON.stringify(entry.statement.kind)};\n    };`,
    )
    .join("\n");
  const aliases: string[] = [];
  if (body.includes("jsonb<")) aliases.push("  type jsonb<T> = T;");
  if (body.includes("json<")) aliases.push("  type json<T> = T;");
  const lines = [
    "/**",
    " * Typed raw SQL, written by okm raw sync.",
    " * A Postgres type with no codec is string, the text the driver returns.",
    " */",
    'import "okmodel/pg";',
    "",
    'declare module "okmodel/pg" {',
    ...aliases,
    "  interface RawStatements {",
    body,
    "  }",
    "}",
    "",
  ];
  return lines.join("\n");
}

function paramsOf(statement: RawLockStatement, codecs: PgTypescriptCodecs | undefined): string {
  return statement.params
    .map((param) =>
      typescriptForPgType(param.pgType, {
        ...(param.enumLabels !== undefined ? { enumLabels: param.enumLabels } : {}),
        ...(codecs !== undefined ? { codecs } : {}),
      }),
    )
    .join(", ");
}

function rowOf(statement: RawLockStatement, codecs: PgTypescriptCodecs | undefined): string {
  return statement.columns
    .map((column) => {
      const type = typescriptForPgType(column.pgType, {
        ...(column.enumLabels !== undefined ? { enumLabels: column.enumLabels } : {}),
        ...(codecs !== undefined ? { codecs } : {}),
      });
      const value = column.nullable ? `${type} | null` : type;
      return `readonly ${propertyName(column.name)}: ${value}`;
    })
    .join("; ");
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function statementJson(statement: RawLockStatement): {
  readonly sql: string;
  readonly kind: RawLockStatement["kind"];
  readonly params: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
} {
  return {
    sql: statement.sql,
    kind: statement.kind,
    params: statement.params.map(typedJson),
    columns: statement.columns.map((column) => ({
      name: column.name,
      pgType: column.pgType,
      nullable: column.nullable,
      ...(column.enumLabels !== undefined ? { enumLabels: [...column.enumLabels] } : {}),
    })),
  };
}

function typedJson(value: { readonly pgType: string; readonly enumLabels?: readonly string[] }): {
  readonly pgType: string;
  readonly enumLabels?: readonly string[];
} {
  return value.enumLabels === undefined
    ? { pgType: value.pgType }
    : { pgType: value.pgType, enumLabels: [...value.enumLabels] };
}

function statementJsonText(statement: RawLockStatement): string {
  return JSON.stringify(statementJson(statement));
}
