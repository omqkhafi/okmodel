/**
 * Hostile database and project setup for one lifecycle case.
 *
 * The migration role, the planted objects, and the replica URL are applied
 * before generate. Product code is not changed here.
 */

import type { Sql } from "postgres";

import { deterministicName } from "../../src/contracts/catalog/identifier.js";
import { replicaUrl } from "../../packages/harness/src/topology.js";
import {
  giveDatabaseToOwner,
  openPostgres,
  ownerUrl,
  SCHEMA_OWNER,
} from "../../packages/harness/src/postgres.js";
import { sqlName, type ColumnModel, type LifecycleCase, type SchemaModel } from "./model.js";

const CREATOR = "okm_creator";
const STRANGER = "okm_stranger";

/** Scratch-shaped schema planted before a clash case. Not created by `okm`. */
export const PLANTED_SCRATCH_SCHEMA = "okm_check_hostile";

/** Connection the case writes with, and the replica `okm check` uses. */
export type PreparedDatabase = {
  readonly writeUrl: string;
  /** Set when `okm check` must use the hot standby. */
  readonly replicaUrl?: string;
  /** A planted `okm_check_*` schema that the scratch assertion allows. */
  readonly plantedScratch: boolean;
};

/**
 * Chooses the login and plants the start state.
 *
 * @param databaseUrl - Superuser URL of the empty database
 * @param item - The case
 * @returns The URL commands should use
 */
export async function prepareDatabase(
  databaseUrl: string,
  item: LifecycleCase,
): Promise<PreparedDatabase> {
  const namespace = item.initial.namespace ?? "public";
  let writeUrl = databaseUrl;
  if (item.role !== "superuser") writeUrl = await giveDatabaseToOwner(databaseUrl);
  if (item.role === "creator") {
    await ensureCreator(databaseUrl, namespace);
    writeUrl = ownerUrl(databaseUrl, CREATOR);
  }
  const replica = item.role === "replica" ? replicaOf(writeUrl) : undefined;
  await plant(databaseUrl, item, namespace);
  return {
    writeUrl,
    ...(replica === undefined ? {} : { replicaUrl: replica }),
    plantedScratch: item.start === "clash" && item.clash === "scratch",
  };
}

/**
 * Points a primary URL at replica `a`, keeping the database and the login.
 *
 * @param databaseUrl - Primary URL
 * @returns The same database on the hot standby
 */
export function replicaOf(databaseUrl: string): string {
  const source = new URL(databaseUrl);
  const replica = new URL(replicaUrl("a"));
  replica.username = decodeURIComponent(source.username);
  replica.password = decodeURIComponent(source.password);
  replica.pathname = source.pathname;
  return replica.href.replace(/\/$/, "");
}

/**
 * Inserts rows until each table has 1000.
 *
 * Existing rows are kept. A later evolution sees the same population.
 *
 * @param databaseUrl - Superuser URL
 * @param model - Schema currently applied
 */
export async function seedThousand(databaseUrl: string, model: SchemaModel): Promise<void> {
  const sql = openPostgres(databaseUrl);
  const schemaName = model.namespace ?? "public";
  try {
    for (const table of model.tables) {
      const target = qualified(schemaName, sqlName(model.casing, table.name));
      const count = await countOf(sql, target);
      const missing = 1000 - count;
      if (missing <= 0) continue;
      const cols: string[] = [];
      const values: string[] = [];
      for (const column of table.columns) {
        if (column.generated !== undefined || column.type === "identity") continue;
        if (column.references !== undefined && column.nullable) continue;
        cols.push(quoteIdent(sqlName(model.casing, column.name)));
        values.push(seriesLiteral(column));
      }
      if (model.tenancy) {
        cols.push(quoteIdent(sqlName(model.casing, "tenantId")));
        values.push("'00000000-0000-4000-8000-000000000099'");
      }
      const start = count + 1;
      const end = count + missing;
      if (cols.length === 0) {
        await sql.unsafe(
          `insert into ${target} select from generate_series(${String(start)}, ${String(end)}) as g`,
        );
        continue;
      }
      await sql.unsafe(
        `insert into ${target} (${cols.join(", ")}) select ${values.join(", ")} from generate_series(${String(start)}, ${String(end)}) as g`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Index name the compiler stores for the case's first index, or `title`.
 *
 * Tenant indexes lead with the tenant key, matching the tenancy rewrite.
 *
 * @param model - Authored schema
 * @returns The SQL index name
 */
export function clashIndexName(model: SchemaModel): string {
  const table = model.tables[model.tables.length - 1];
  if (table === undefined) {
    return deterministicName({ parent: "notes", purpose: "index", nameKey: "title" });
  }
  const index = table.indexes.find((item) => !item.usingTrgm) ?? table.indexes[0];
  const keys = index?.columns ?? ["title"];
  const sqlCols = keys.map((key) => {
    const column = table.columns.find((item) => item.key === key);
    return sqlName(model.casing, column?.name ?? key);
  });
  if (model.tenancy) sqlCols.unshift(sqlName(model.casing, "tenantId"));
  return deterministicName({
    parent: sqlName(model.casing, table.name),
    purpose: "index",
    nameKey: sqlCols.join("_"),
  });
}

async function ensureCreator(databaseUrl: string, namespace: string): Promise<void> {
  const name = databaseName(databaseUrl);
  const sql = openPostgres(databaseUrl);
  try {
    await sql.unsafe(
      `do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${CREATOR}') then
          create role ${CREATOR} nosuperuser nobypassrls nocreaterole login password 'okm';
        else
          alter role ${CREATOR} nosuperuser nobypassrls nocreaterole login password 'okm';
        end if;
      end $$`,
    );
    await sql.unsafe(`grant connect on database ${name} to ${CREATOR}`);
    // `okm migrate check` creates `okm_check_<uuid>`. CREATE SCHEMA needs this
    // privilege. Without it the command fails with "permission denied for
    // database" (creator-scratch-pg.test.ts).
    await sql.unsafe(`grant create on database ${name} to ${CREATOR}`);
    await sql.unsafe(`grant usage on schema public to ${CREATOR}`);
    if (namespace === "public") {
      await sql.unsafe(`grant create on schema public to ${CREATOR}`);
      return;
    }
    const schema = quoteIdent(namespace);
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(`alter schema ${schema} owner to ${SCHEMA_OWNER}`);
    await sql.unsafe(`grant usage, create on schema ${schema} to ${CREATOR}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function plant(databaseUrl: string, item: LifecycleCase, namespace: string): Promise<void> {
  if (item.start === "empty" || item.start === "rows") return;
  const sql = openPostgres(databaseUrl);
  try {
    await sql.unsafe(
      `do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${STRANGER}') then
          create role ${STRANGER} nosuperuser nologin;
        end if;
      end $$`,
    );
    if (item.start === "foreign") {
      // Outside the managed schema. Objects there must not count as the target.
      // pgcrypto is trusted, so the stranger can own it. There is no ALTER EXTENSION OWNER.
      const name = databaseName(databaseUrl);
      await sql.unsafe("create schema if not exists stranger");
      await sql.unsafe(`grant usage, create on schema stranger to ${STRANGER}`);
      await sql.unsafe(`grant create on database ${name} to ${STRANGER}`);
      const reserved = await sql.reserve();
      try {
        await reserved.unsafe(`set role ${STRANGER}`);
        await reserved.unsafe("create extension if not exists pgcrypto schema stranger");
        await reserved.unsafe(
          "create table if not exists stranger.stranger_notes (id int primary key, note text)",
        );
        await reserved.unsafe("reset role");
      } finally {
        reserved.release();
      }
      await sql.unsafe(`revoke create on database ${name} from ${STRANGER}`);
      await sql.unsafe(`alter schema stranger owner to ${STRANGER}`);
      return;
    }
    if (item.clash === "scratch") {
      await sql.unsafe(`create schema if not exists ${PLANTED_SCRATCH_SCHEMA}`);
      await sql.unsafe(`create table if not exists ${PLANTED_SCRATCH_SCHEMA}.kept (id int)`);
      await sql.unsafe(`alter schema ${PLANTED_SCRATCH_SCHEMA} owner to ${STRANGER}`);
      return;
    }
    const schema = quoteIdent(namespace);
    if (namespace !== "public") {
      await sql.unsafe(`create schema if not exists ${schema}`);
      const owner = item.role === "superuser" ? "okm" : SCHEMA_OWNER;
      await sql.unsafe(`alter schema ${schema} owner to ${owner}`);
    }
    if (item.clash === "steps") {
      await sql.unsafe(`create table if not exists ${schema}.okm_steps (id integer primary key)`);
      await sql.unsafe(`alter table ${schema}.okm_steps owner to ${STRANGER}`);
      await sql.unsafe(`revoke all on table ${schema}.okm_steps from public`);
      return;
    }
    // `okm_steps` is bookkeeping, so a real-shaped table does not occupy the
    // target. The index name is the one the compiler will use.
    const index = clashIndexName(item.initial);
    const owner = writeRole(item.role);
    await sql.unsafe(`create table if not exists ${schema}.okm_steps (
      migration_id text not null,
      step_index integer not null,
      kind text not null,
      sql_hash text not null,
      state text not null,
      attempt integer not null,
      started_at timestamptz not null,
      finished_at timestamptz,
      runner text,
      error_code text,
      error_text text,
      primary key (migration_id, step_index),
      constraint okm_steps_state check (state in ('started', 'failed', 'retry'))
    )`);
    await sql.unsafe(
      `create index if not exists ${quoteIdent(index)} on ${schema}.okm_steps (migration_id)`,
    );
    await sql.unsafe(`alter table ${schema}.okm_steps owner to ${owner}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function writeRole(role: LifecycleCase["role"]): string {
  if (role === "creator") return CREATOR;
  if (role === "superuser") return "current_user";
  return SCHEMA_OWNER;
}

function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
  return name;
}

async function countOf(sql: Sql, target: string): Promise<number> {
  const rows = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${target}`);
  return Number(rows[0]?.n ?? "0");
}

function seriesLiteral(column: ColumnModel): string {
  const listed = column.picklist?.[0];
  if (listed !== undefined) return `'${listed.replaceAll("'", "''")}'`;
  switch (column.type) {
    case "integer":
    case "smallint":
    case "bigint":
    case "numeric":
    case "domain":
      return "g";
    case "boolean":
      return "true";
    case "uuid":
      return "('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid";
    case "timestamptz":
      return "'2020-01-02T03:04:05Z'";
    case "jsonb":
      return "'{}'::jsonb";
    case "enum":
      return `'${(column.enumLabels?.[0] ?? "red").replaceAll("'", "''")}'`;
    default:
      return "('t' || g::text)";
  }
}

function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
