/**
 * Snapshot provisioning (section 19.6, invariant J).
 *
 * An empty target receives the head snapshot and `reference` rows. History
 * records `provisioned@<migration id>`. Expand, backfill, and contract steps
 * are not replayed.
 */

import type { Sql } from "postgres";

import { introspectObjects } from "../catalog/introspect.js";
import { postgresRunner } from "../catalog/runners.js";
import {
  normalizeIntrospected,
  rebindNamespace,
  type NormalizedObject,
} from "../catalog/normalize.js";
import type { NamespaceName } from "../catalog/object.js";
import type { NamespaceBinding } from "../catalog/render.js";
import { quoteIdent } from "../catalog/sql.js";
import { TargetError } from "./error.js";
import { assertTargetPolicy } from "./policy.js";
import { referenceInserts, type ReferenceDeclaration } from "./reference.js";

/** What provisioning wrote. */
export type ProvisionResult = {
  /** Wall time of the snapshot install, in milliseconds. */
  readonly ms: number;
  /** History ids after provisioning. */
  readonly history: readonly string[];
};

/**
 * Installs the head snapshot on an empty target.
 *
 * A namespace that already contains objects, or an `okm_meta` row, is refused
 * (OKM1851). Protected empty targets are allowed. `--allow-protected` is not
 * required for that case.
 *
 * @param options - Connection, namespace, snapshot SQL, and reference rows
 * @returns Duration and history
 */
export async function provisionTarget(options: {
  readonly sql: Sql;
  readonly schema: string;
  readonly snapshot: readonly string[];
  readonly references: readonly ReferenceDeclaration[];
  readonly migrationId: string;
  readonly catalogHash: string;
  readonly protected: boolean;
  readonly allowProtected?: boolean;
}): Promise<ProvisionResult> {
  await assertEmpty(options.sql, options.schema);
  assertTargetPolicy(
    { protected: options.protected },
    "provision",
    options.allowProtected === undefined
      ? { empty: true }
      : { empty: true, allowProtected: options.allowProtected },
  );
  const started = performance.now();
  await options.sql.unsafe(`create schema if not exists ${quoteIdent(options.schema)}`);
  for (const statement of options.snapshot) {
    await options.sql.unsafe(statement);
  }
  for (const statement of referenceInserts(options.schema, options.references)) {
    await options.sql.unsafe(statement);
  }
  await ensureMeta(options.sql, options.schema);
  const historyId = `provisioned@${options.migrationId}`;
  await options.sql.unsafe(
    `insert into ${quoteIdent(options.schema)}.okm_meta (id, catalog_hash, kind) values ($1, $2, 'provisioned')`,
    [historyId, options.catalogHash],
  );
  const history = await readHistory(options.sql, options.schema);
  return { ms: performance.now() - started, history };
}

/**
 * Reads a namespace back through the normalisation pipeline.
 *
 * `okm_meta` is omitted. History is not part of the catalog.
 *
 * @param sql - Connection that can see the schema
 * @param schema - Concrete schema
 * @param logical - Namespace the comparison uses
 * @returns Normalised objects
 */
export async function introspectNamespace(
  sql: Sql,
  schema: string,
  logical: NamespaceName,
): Promise<readonly NormalizedObject[]> {
  const bindings: readonly NamespaceBinding[] = [{ logical, concrete: schema }];
  const introspected = await introspectObjects(postgresRunner(sql), [schema], []);
  return introspected
    .map((object) => normalizeIntrospected(object))
    .map((object) => rebindNamespace(object, bindings))
    .filter((object) => object.name !== "okm_meta" && object.parent !== "okm_meta");
}

/**
 * Clones a database with `CREATE DATABASE ... TEMPLATE`.
 *
 * The source must have no other sessions. Returns the clone time in milliseconds.
 *
 * @param admin - Connection to a different database
 * @param source - Populated database
 * @param clone - New database name
 * @returns Wall time of the clone
 */
export async function cloneDatabase(admin: Sql, source: string, clone: string): Promise<number> {
  const started = performance.now();
  await admin.unsafe(`create database ${quoteIdent(clone)} template ${quoteIdent(source)}`);
  return performance.now() - started;
}

async function assertEmpty(sql: Sql, schema: string): Promise<void> {
  const rows = await sql.unsafe(
    `select c.relname as name
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')`,
    [schema],
  );
  const names = rows.map((row) => text(row.name));
  const userObjects = names.filter((name) => name !== "okm_meta");
  if (userObjects.length > 0) {
    throw new TargetError(
      "OKM1851",
      `${schema} is not empty (${userObjects.join(", ")}) and has no history to resume.`,
    );
  }
  if (!names.includes("okm_meta")) return;
  const history = await readHistory(sql, schema);
  if (history.length > 0) {
    throw new TargetError("OKM1851", `${schema} already has migration history.`);
  }
}

async function ensureMeta(sql: Sql, schema: string): Promise<void> {
  await sql.unsafe(`
    create table if not exists ${quoteIdent(schema)}.okm_meta (
      id text primary key,
      catalog_hash text not null,
      kind text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readHistory(sql: Sql, schema: string): Promise<readonly string[]> {
  const rows = await sql.unsafe(
    `select id from ${quoteIdent(schema)}.okm_meta order by applied_at, id`,
  );
  return rows.map((row) => text(row.id));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}
