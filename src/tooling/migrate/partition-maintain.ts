/**
 * `okm partitions` and the creation half of `okm apply`.
 *
 * Reads bounds in UTC. Creates a missing child with a validated check and
 * `attach partition`. `detach concurrently` runs outside a transaction, and a
 * pending detach is finalized first. This module loads only from those commands.
 */

import postgres, { type Sql } from "postgres";
import { OkmError } from "../../contracts/error.js";
import type {
  Catalog,
  PartitionChild,
  TableObject,
  TablePartition,
} from "../../contracts/catalog/types.js";
import { qualify } from "../../dialects/pg/ddl.js";
import {
  childName,
  daysLeft,
  expiredSuffixes,
  parseBound,
  partitionChange,
  sameBound,
} from "../../dialects/pg/partition-compile.js";
import { liveAttachStatements } from "../../dialects/pg/partition-sql.js";
import { driverUrl } from "./driver-url.js";
import { lockWaiter, type LockTally } from "./lock-wait.js";
import { refusePooler } from "./pooler.js";

/** One child as `okm partitions` reports it. */
export type PartitionReportChild = {
  readonly name: string;
  readonly suffix: string;
  readonly bound: string;
  readonly rows: number;
  readonly bytes: number;
};

/** The read-only report. */
export type PartitionReport = {
  readonly table: string;
  readonly managed: boolean;
  readonly daysLeft: number | null;
  readonly defaultRows: number;
  readonly gaps: readonly string[];
  readonly overlaps: readonly string[];
  readonly children: readonly PartitionReportChild[];
};

const DAYS_LEFT = 7;

function client(url: string): Sql {
  return postgres(driverUrl(url), { max: 1, idle_timeout: 1 });
}

/**
 * Reads one partitioned table.
 *
 * @param url - Target URL
 * @param schema - Concrete schema
 * @param table - Declared table
 * @returns Bounds, estimates, gaps, and days left
 */
export async function describePartitions(
  url: string,
  schema: string,
  table: TableObject,
): Promise<PartitionReport> {
  const sql = client(url);
  try {
    return await describeOn(sql, schema, table);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Creates missing partitions for every managed rule. Does not detach.
 *
 * @param input - Target, catalog, and lock budget
 */
export async function ensurePartitionWindow(input: {
  readonly url: string;
  readonly catalog: Catalog;
  readonly schema: string;
  readonly lockTimeoutMs: number;
  readonly lockWaitMs: number;
}): Promise<void> {
  const tables = managedTables(input.catalog);
  if (tables.length === 0) return;
  const sql = client(input.url);
  try {
    for (const table of tables) {
      await createMissing(
        sql,
        input.schema,
        table,
        input.catalog,
        input.lockTimeoutMs,
        input.lockWaitMs,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Creates the window and applies `keep`.
 *
 * @param input - Target, table, and flags
 * @returns The statements, and whether they ran
 */
export async function maintainPartitions(input: {
  readonly url: string;
  readonly schema: string;
  readonly catalog: Catalog;
  readonly table: TableObject;
  readonly dryRun: boolean;
  readonly allowProtected: boolean;
  readonly lockTimeoutMs: number;
  readonly lockWaitMs: number;
}): Promise<{ readonly statements: readonly string[]; readonly ran: boolean }> {
  const { resolvePooler } = await import("./pooler-probe.js");
  refusePooler(await resolvePooler(input.url), false);
  const partition = input.table.definition.partition;
  if (partition === undefined || partition.ownership === "external") {
    throw new OkmError(
      "OKM1932",
      `Table ${input.table.identity.name} has no OKM-managed partition rule.`,
      { fix: { summary: 'Declare a rule, or leave children: "external" to another tool.' } },
    );
  }
  const sql = client(input.url);
  try {
    const statements = [
      ...(await missingStatements(sql, input.schema, input.table, input.catalog)),
      ...(await keepStatements(sql, input.schema, input.table, partition, input.allowProtected)),
    ];
    if (!input.dryRun) {
      await runStatements(sql, statements, input.lockTimeoutMs, input.lockWaitMs);
    }
    return { statements, ran: !input.dryRun };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Doctor lines for a managed rule whose window is short.
 *
 * @param url - Target URL
 * @param catalog - Declared catalog
 * @param schema - Concrete schema
 * @returns Lines to print. Empty when nothing is due
 */
export async function partitionDoctorLines(
  url: string,
  catalog: Catalog,
  schema: string,
): Promise<readonly string[]> {
  const tables = managedTables(catalog);
  if (tables.length === 0) return [];
  const sql = client(url);
  try {
    const lines: string[] = [];
    for (const table of tables) {
      const report = await describeOn(sql, schema, table);
      if (report.daysLeft !== null && report.daysLeft < DAYS_LEFT) {
        lines.push(
          `OKM2130 ${table.identity.name}: ${String(report.daysLeft)} days left in the last partition. Run okm partitions maintain.`,
        );
      }
      const declared = table.definition.partition?.children ?? [];
      const live = await liveOf(sql, schema, table.identity.name);
      const missing = declared.filter(
        (child) => !live.some((item) => sameBound(item.bound, child.bound)),
      );
      if (missing.length > 0) {
        lines.push(
          `OKM2130 ${table.identity.name}: ahead is not satisfied (${String(missing.length)} missing). Run okm partitions maintain.`,
        );
      }
      if (report.defaultRows > 0) {
        lines.push(
          `OKM2130 ${table.identity.name}: default partition has about ${String(report.defaultRows)} rows. Move them before adding a partition for that range.`,
        );
      }
      lines.push(...(await childGrantLines(sql, schema, table.identity.name, live)));
    }
    return lines;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Fails when pg_partman and an OKM rule both own a table.
 *
 * A missing `partman.part_config` passes. The only column read is
 * `parent_table`, the primary key of pg_partman's `part_config`. That table
 * also requires `control`, `partition_interval`, and `partition_type`. Those
 * columns are not part of this check. This is not a proof the extension is
 * installed.
 *
 * @param url - Target URL
 * @param catalog - Declared catalog
 * @param schema - Concrete schema
 */
export async function assertPartitionManager(
  url: string,
  catalog: Catalog,
  _schema: string,
): Promise<void> {
  const managed = new Set(managedTables(catalog).map((table) => table.identity.name));
  if (managed.size === 0) return;
  const sql = client(url);
  try {
    const present = await sql<{ rel: string | null }[]>`
      select to_regclass('partman.part_config')::text as rel
    `;
    if (present[0]?.rel == null) return;
    let rows: { parent_table: string }[];
    try {
      rows = await sql.unsafe<{ parent_table: string }[]>(
        "select parent_table from partman.part_config",
      );
    } catch {
      return;
    }
    const hit = rows.filter((row) => {
      const name = row.parent_table.split(".").pop() ?? row.parent_table;
      return managed.has(name);
    });
    if (hit.length === 0) return;
    throw new OkmError(
      "OKM2210",
      `partman.part_config lists ${hit.map((row) => row.parent_table).join(", ")}, and that table has an OKM partition rule. pg_partman stops pre-making after a partition OKM created.`,
      {
        fix: {
          summary:
            'Remove the partman row, or set children: "external" and let pg_partman own the children.',
        },
      },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function describeOn(sql: Sql, schema: string, table: TableObject): Promise<PartitionReport> {
  const live = await liveOf(sql, schema, table.identity.name);
  const ranges = live.filter((child) => child.bound.kind === "range");
  const gaps: string[] = [];
  const overlaps: string[] = [];
  const ordered = [...ranges].sort((left, right) =>
    left.bound.kind === "range" && right.bound.kind === "range"
      ? left.bound.from.localeCompare(right.bound.from)
      : 0,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const next = ordered[index];
    if (previous?.bound.kind !== "range" || next?.bound.kind !== "range") continue;
    if (next.bound.from > previous.bound.to) gaps.push(`${previous.suffix} .. ${next.suffix}`);
    if (next.bound.from < previous.bound.to)
      overlaps.push(`${previous.suffix} overlaps ${next.suffix}`);
  }
  const fallback = table.definition.partition?.children ?? [];
  const left = daysLeft(ranges.length > 0 ? ranges : fallback, Date.now());
  const defaultChild = live.find((child) => child.bound.kind === "default");
  return {
    table: table.identity.name,
    managed: table.definition.partition?.ownership !== "external",
    daysLeft: left ?? null,
    defaultRows: defaultChild?.rows ?? 0,
    gaps,
    overlaps,
    children: live.map((child) => ({
      name: child.name,
      suffix: child.suffix,
      bound: child.text,
      rows: child.rows,
      bytes: child.bytes,
    })),
  };
}

type LiveChild = PartitionChild & {
  readonly name: string;
  readonly text: string;
  readonly rows: number;
  readonly bytes: number;
};

async function liveOf(sql: Sql, schema: string, table: string): Promise<readonly LiveChild[]> {
  const saved = await sql<{ tz: string }[]>`select current_setting('TimeZone') as tz`;
  const zone = saved[0]?.tz ?? "UTC";
  await sql`select set_config('TimeZone', 'UTC', false)`;
  try {
    const rows = await sql.unsafe<{ name: string; bound: string; rows: string; bytes: string }[]>(
      `select child.relname as name,
         pg_get_expr(child.relpartbound, child.oid) as bound,
         child.reltuples::text as rows,
         pg_total_relation_size(child.oid)::text as bytes
       from pg_inherits i
       join pg_class parent on parent.oid = i.inhparent
       join pg_class child on child.oid = i.inhrelid
       join pg_namespace n on n.oid = parent.relnamespace
       where n.nspname = $1 and parent.relname = $2
         and child.relispartition and child.relkind in ('r', 'p', 'f')
       order by child.relname`,
      [schema, table],
    );
    const found: LiveChild[] = [];
    for (const row of rows) {
      const bound = parseBound(row.bound);
      if (bound === undefined) continue;
      const prefix = `${table}_`;
      found.push({
        name: row.name,
        suffix: row.name.startsWith(prefix) ? row.name.slice(prefix.length) : row.name,
        bound,
        text: row.bound,
        rows: Math.max(0, Math.round(Number(row.rows))),
        bytes: Number(row.bytes),
      });
    }
    return found;
  } finally {
    await sql.unsafe("select set_config('TimeZone', $1, false)", [zone]);
  }
}

async function createMissing(
  sql: Sql,
  schema: string,
  table: TableObject,
  catalog: Catalog,
  lockTimeoutMs: number,
  lockWaitMs: number,
): Promise<void> {
  const statements = await missingStatements(sql, schema, table, catalog);
  await runStatements(sql, statements, lockTimeoutMs, lockWaitMs);
}

async function missingStatements(
  sql: Sql,
  schema: string,
  table: TableObject,
  catalog: Catalog,
): Promise<readonly string[]> {
  const partition = table.definition.partition;
  if (partition === undefined) return [];
  const live = await liveOf(sql, schema, table.identity.name);
  const before: TablePartition = {
    method: partition.method,
    columns: partition.columns,
    children: live,
  };
  const change = partitionChange(before, partition);
  if (change.kind !== "attach") return [];
  return liveAttachStatements(table, catalog, schema, change.missing).map(
    (statement) => statement.sql,
  );
}

async function keepStatements(
  sql: Sql,
  schema: string,
  table: TableObject,
  partition: TablePartition,
  allowProtected: boolean,
): Promise<readonly string[]> {
  const live = await liveOf(sql, schema, table.identity.name);
  const parent = qualify(schema, table.identity.name);
  const pending = await pendingDetaches(sql, schema, table.identity.name);
  const statements: string[] = [];
  for (const name of pending) {
    statements.push(`alter table ${parent} detach partition ${qualify(schema, name)} finalize`);
  }
  const expired = expiredSuffixes(live, partition.rule, Date.now());
  if (expired.length === 0) return statements;
  const then = partition.rule?.keepThen ?? "detach";
  if (then === "drop" && !allowProtected) {
    throw new OkmError(
      "OKM1932",
      `Table ${table.identity.name} keep.then is drop. That removes the detached table.`,
      { fix: { summary: "Pass --allow-protected, or use keep.then detach." } },
    );
  }
  for (const suffix of expired) {
    const name = childName(table.identity.name, suffix);
    statements.push(`alter table ${parent} detach partition ${qualify(schema, name)} concurrently`);
    if (then === "drop") statements.push(`drop table ${qualify(schema, name)}`);
  }
  return statements;
}

async function pendingDetaches(
  sql: Sql,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await sql.unsafe<{ name: string }[]>(
    `select child.relname as name
     from pg_inherits i
     join pg_class parent on parent.oid = i.inhparent
     join pg_class child on child.oid = i.inhrelid
     join pg_namespace n on n.oid = parent.relnamespace
     where n.nspname = $1 and parent.relname = $2 and i.inhdetachpending`,
    [schema, table],
  );
  return rows.map((row) => row.name);
}

async function childGrantLines(
  sql: Sql,
  schema: string,
  table: string,
  live: readonly LiveChild[],
): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const child of live) {
    const grants = await sql.unsafe<{ grantee: string }[]>(
      `select distinct grantee
       from information_schema.role_table_grants
       where table_schema = $1 and table_name = $2 and grantee <> current_user`,
      [schema, child.name],
    );
    if (grants.length === 0) continue;
    lines.push(
      `OKM2130 ${table}.${child.name}: direct grant to ${grants.map((row) => row.grantee).join(", ")}. Policies on the parent do not apply to a child grant.`,
    );
  }
  return lines;
}

async function runStatements(
  sql: Sql,
  statements: readonly string[],
  lockTimeoutMs: number,
  lockWaitMs: number,
): Promise<void> {
  const tally: LockTally = { attempts: 0, waitedMs: 0 };
  const waiter = lockWaiter(
    { waitMs: lockWaitMs, lockTimeoutMs, earlier: () => false, tally },
    "partitions",
  );
  for (const statement of statements) {
    const concurrent = /\bconcurrently\b/i.test(statement);
    await waiter.run(async () => {
      if (concurrent) {
        await sql.unsafe(`set lock_timeout = '${String(lockTimeoutMs)}ms'`);
        await sql.unsafe(statement);
        return;
      }
      await sql.unsafe("begin");
      try {
        await sql.unsafe(`select set_config('lock_timeout', $1, true)`, [
          `${String(lockTimeoutMs)}ms`,
        ]);
        await sql.unsafe(statement);
        await sql.unsafe("commit");
      } catch (error) {
        await sql.unsafe("rollback").catch(() => undefined);
        throw error;
      }
    });
  }
}

function managedTables(catalog: Catalog): readonly TableObject[] {
  return catalog.objects.filter(
    (object): object is TableObject =>
      object.kind === "table" &&
      object.definition.partition !== undefined &&
      object.definition.partition.ownership !== "external",
  );
}
