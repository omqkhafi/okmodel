/**
 * Describes static `raw()` calls and writes `.okm/raw.lock.json` and
 * `.okm/raw.d.ts`. Nothing here runs the statement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DescribeResult } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import type { PgTypescriptCodecs } from "../../dialects/pg/emit.js";
import { errorDoc } from "../errors/registry.js";
import type { Finding } from "../migrate/lint.js";
import { attributeFacts, columnNullability, NULLABILITY_SQL } from "./nullability.js";
import {
  assertLocked,
  assertSignature,
  parseLock,
  renderLock,
  renderRawTypes,
  staleLockCodes,
  type RawLock,
  type RawLockColumn,
  type RawLockParam,
  type RawLockStatement,
} from "./lock.js";
import type { CatalogQuery, ResolvedType } from "./types.js";
import { resolvePgTypes } from "./types.js";
import type { RawCall } from "./scan.js";

/** A connection that can describe and read the catalog. It does not execute the user statement. */
export type RawSession = {
  /** Unnamed Parse and statement Describe. */
  describe(sql: string): Promise<DescribeResult>;
  /** Catalog reads. Values come back as text. */
  query: CatalogQuery;
};

/**
 * Describes one statement and builds its lock entry.
 *
 * @param sql - Normalised statement
 * @param kind - Read or write
 * @param described - Parameter OIDs and result fields
 * @param query - Catalog reader for this connection
 * @returns The lock entry
 * @throws OkmError OKM1602 when two columns share a name
 */
export async function lockStatement(
  sql: string,
  kind: RawLockStatement["kind"],
  described: DescribeResult,
  query: CatalogQuery,
): Promise<RawLockStatement> {
  const oids = [...described.parameters, ...described.fields.map((field) => field.typeOid)];
  const types =
    oids.length === 0 ? new Map<number, ResolvedType>() : await resolvePgTypes(query, oids);
  const params: RawLockParam[] = described.parameters.map((oid) => typed(types.get(oid)));
  const columns: RawLockColumn[] = [];
  const names = new Set<string>();
  for (const field of described.fields) {
    const facts =
      field.tableOid === 0 || field.attnum === 0
        ? undefined
        : attributeFacts((await query(nullabilitySql(field.tableOid, field.attnum)))[0] ?? []);
    const decision = columnNullability(sql, field, facts);
    if (names.has(decision.name)) {
      throw new OkmError("OKM1602", `Raw SQL result column ${decision.name} is repeated.`, {
        fix: { summary: "Give the result columns distinct names." },
      });
    }
    names.add(decision.name);
    const resolved = typed(types.get(field.typeOid));
    columns.push({
      name: decision.name,
      pgType: resolved.pgType,
      nullable: decision.nullable,
      ...(resolved.enumLabels !== undefined ? { enumLabels: resolved.enumLabels } : {}),
    });
  }
  return { sql, kind, params, columns };
}

/**
 * Describes every distinct statement.
 *
 * @param calls - Static calls. Calls that share a normalised text share one entry
 * @param catalogHash - Schema catalog hash stored on the lock
 * @param session - Describe and catalog reader
 * @returns The lock
 */
export async function buildRawLock(
  calls: readonly RawCall[],
  catalogHash: string,
  session: RawSession,
): Promise<RawLock> {
  const statements: Record<string, RawLockStatement> = {};
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.key)) continue;
    seen.add(call.key);
    let described: DescribeResult;
    try {
      described = await session.describe(call.normalised);
    } catch (error) {
      throw describeFailure(error);
    }
    statements[call.key] = await lockStatement(
      call.normalised,
      call.kind,
      described,
      session.query,
    );
  }
  return { version: 1, dialect: "postgres", catalogHash, statements };
}

/**
 * Writes the lock and the declaration, or reports that they would change.
 *
 * @param directory - `.okm` directory
 * @param calls - Static calls
 * @param lock - Described lock
 * @param codecs - Schema codecs
 * @param check - When true, write nothing and throw OKM1601 if either file would change
 * @returns Whether the files already matched
 */
export function commitRawArtifacts(
  directory: string,
  calls: readonly RawCall[],
  lock: RawLock,
  codecs: PgTypescriptCodecs | undefined,
  check: boolean,
): boolean {
  const lockText = renderLock(lock);
  const typesText = renderRawTypes(calls, lock, codecs);
  const lockPath = join(directory, "raw.lock.json");
  const typesPath = join(directory, "raw.d.ts");
  const unchanged = readIfSame(lockPath, lockText) && readIfSame(typesPath, typesText);
  if (unchanged || check) {
    if (!unchanged) throw staleFiles();
    return true;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(lockPath, lockText);
  writeFileSync(typesPath, typesText);
  return false;
}

/**
 * Offline drift. A missing entry throws OKM1604. A stale entry is a warning.
 *
 * @param calls - Static calls
 * @param lockText - Lock file text, or `undefined` when the file is absent
 * @returns Warning findings
 */
export function offlineRawDrift(
  calls: readonly RawCall[],
  lockText: string | undefined,
): readonly Finding[] {
  const discovered = unique(calls.map((call) => call.key));
  const locked = lockText === undefined ? undefined : Object.keys(parseLock(lockText).statements);
  assertLocked(discovered, locked);
  if (locked === undefined) return [];
  if (staleLockCodes(discovered, locked).length === 0) return [];
  const doc = errorDoc("OKM1605");
  return [
    {
      severity: "warning",
      code: "OKM1605",
      place: "raw.lock.json",
      reason: doc?.summary ?? "A typed SQL lock entry is no longer in the source.",
      fix: doc?.fix ?? "Run okm raw sync and commit the lock.",
    },
  ];
}

/**
 * Re-describes the lock and throws OKM1601 when a signature changed.
 *
 * @param calls - Static calls
 * @param lock - Lock on disk
 * @param session - Describe and catalog reader
 */
export async function assertRawFresh(
  calls: readonly RawCall[],
  lock: RawLock,
  session: RawSession,
): Promise<void> {
  const described = await buildRawLock(calls, lock.catalogHash, session);
  for (const [hash, statement] of Object.entries(lock.statements)) {
    const next = described.statements[hash];
    if (next === undefined) continue;
    assertSignature(statement, next);
  }
}

/**
 * Lock file text, when the project has one.
 *
 * @param directory - `.okm` directory
 * @returns The text, or `undefined`
 */
export function readRawLock(directory: string): string | undefined {
  const path = join(directory, "raw.lock.json");
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function typed(resolved: ResolvedType | undefined): RawLockParam {
  if (resolved === undefined) return { pgType: "unknown" };
  return resolved.enumLabels === undefined
    ? { pgType: resolved.pgType }
    : { pgType: resolved.pgType, enumLabels: resolved.enumLabels };
}

function nullabilitySql(tableOid: number, attnum: number): string {
  if (
    !Number.isInteger(tableOid) ||
    !Number.isInteger(attnum) ||
    tableOid < 0 ||
    attnum < 0 ||
    tableOid > 0xffffffff ||
    attnum > 0xffff
  ) {
    throw new Error("table oid and attnum must be integers");
  }
  return NULLABILITY_SQL.replaceAll("$1::oid", `${String(tableOid)}::oid`).replaceAll(
    "$2::int",
    `${String(attnum)}::int`,
  );
}

function describeFailure(error: unknown): OkmError {
  if (error instanceof OkmError && error.code === "OKM1602") return error;
  const message = error instanceof Error ? error.message : "The statement could not be described.";
  return new OkmError("OKM1602", message, {
    fix: {
      summary: "Make the statement one command the server can plan. Describe does not run it.",
    },
  });
}

function staleFiles(): OkmError {
  const doc = errorDoc("OKM1601");
  return new OkmError(doc?.code ?? "OKM1601", doc?.summary ?? "Typed SQL is stale.", {
    fix: { summary: doc?.fix ?? "Run okm raw sync and commit the lock." },
  });
}

function readIfSame(path: string, text: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8") === text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
