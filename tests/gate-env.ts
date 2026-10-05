/**
 * A real-Postgres environment for the 0.2 gate tests.
 *
 * One isolated schema, the gate schema's DDL, a recording pool, and a row-level
 * audit trigger on every tenant table. The trigger raises a notice for every row
 * a statement writes, with the row's tenant. A notice survives a rollback, so a
 * write that a failed `tx` undid is still audited. A raw connection reads the
 * tables without okmodel, which is the oracle the tests compare against.
 */

import type { Sql } from "postgres";

import type { Notice, Statement } from "../src/contracts/driver.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect, open } from "../src/runtime/pg/postgresjs.js";
import type { Hookm } from "../src/runtime/types.js";
import { record, type Recording } from "./gate-recorder.js";
import { gateApp, TENANT_TABLES, type TenantTable } from "./gate-schema.js";

/** SQL table name of each tenant table. */
export const SQL_NAME: Readonly<Record<TenantTable, string>> = {
  orgs: "orgs",
  projects: "projects",
  tasks: "tasks",
  labels: "labels",
  projectLabels: "project_labels",
};

/** A row read straight from the table, keys in camel case. */
export type Raw = Record<string, unknown> & {
  readonly id: string;
  readonly tenantId: string;
  readonly archivedAt: string | null;
  readonly archiveId: string | null;
};

/** One row written, as the audit trigger saw it. */
export type Audit = {
  readonly table: string;
  readonly op: string;
  readonly tenant: string;
};

/** The connected client type for the gate schema. */
export type GateDb = ReturnType<typeof connect<typeof gateApp>>;

/** What a test gets. */
export type GateEnv = {
  readonly db: GateDb;
  readonly rec: Recording;
  readonly sql: Sql;
  readonly schemaName: string;
  /** Rows written since the last {@link GateEnv.drain}, as the trigger saw them. */
  readonly audits: Audit[];
  /** Empties the audit and statement logs. */
  drain(): void;
  /** Every row of a table for one tenant (all states), ordered by id. */
  rows(table: TenantTable, tenant: string): Promise<Raw[]>;
  /** Every row of every tenant table for one tenant, as one string. */
  snapshot(tenant: string): Promise<string>;
  /** Deletes every row of every tenant table. */
  clear(): Promise<void>;
};

/** Options of {@link withGate}. */
export type GateOptions = {
  /** Connections in the pool. Default 1, so every tenant reuses the one connection. */
  readonly max?: number;
  /** Changes statements on the wire. Only a test of the harness itself sets this. */
  readonly mutate?: (statement: Statement) => Statement;
};

/**
 * A wire change a child run asks for with `OKM_GATE_MUTATE`, so `gate-sensitivity.test.ts`
 * can prove the safety property fails when the wire is wrong.
 *
 * - `hidden`: a select returns `notes` (a hidden column) where it says `tier`.
 * - `active`: a preset read loses the active-set predicate.
 * - `restore`: a restore no longer waits for an archived parent.
 *
 * @returns The change, or `undefined` when no mutation is asked for
 */
function envMutation(): ((statement: Statement) => Statement) | undefined {
  const mode = process.env.OKM_GATE_MUTATE;
  if (mode === "hidden") {
    return (statement) =>
      /^select /i.test(statement.text)
        ? { ...statement, text: statement.text.replace('t."tier"', 't."notes"') }
        : statement;
  }
  if (mode === "active") {
    return (statement) =>
      /^select /i.test(statement.text) && statement.text.includes('"starred"')
        ? { ...statement, text: statement.text.replace(' and t."archived_at" is null', "") }
        : statement;
  }
  if (mode === "restore") {
    return (statement) =>
      statement.text.includes(" and not exists (select 1 from blocked)")
        ? {
            ...statement,
            text: statement.text.replaceAll(" and not exists (select 1 from blocked)", ""),
          }
        : statement;
  }
  return undefined;
}

const NOTICE = /^okm_audit\|([^|]+)\|([^|]+)\|([^|]+)$/;

function camel(name: string): string {
  return name.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Runs `fn` against a fresh schema with the gate tables, the audit trigger and a recording pool.
 *
 * @param options - Pool size
 * @param fn - The test body
 * @returns Whatever `fn` returns
 */
export async function withGate<T>(
  options: GateOptions,
  fn: (env: GateEnv) => Promise<T>,
): Promise<T> {
  return withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(gateApp.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(`
      create function okm_audit() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise notice 'okm_audit|%|%|%', tg_table_name, tg_op, old.tenant_id;
        else
          raise notice 'okm_audit|%|%|%', tg_table_name, tg_op, new.tenant_id;
        end if;
        return null;
      end $$`);
    for (const table of TENANT_TABLES) {
      const name = SQL_NAME[table];
      await sql.unsafe(
        `create trigger okm_audit_${name} after insert or update or delete on ${name}
           for each row execute function okm_audit()`,
      );
    }
    const audits: Audit[] = [];
    const hookm: Hookm = {
      onNotice(notice: Notice) {
        const found = NOTICE.exec(notice.message);
        if (found !== null) {
          audits.push({ table: found[1] ?? "", op: found[2] ?? "", tenant: found[3] ?? "" });
        }
      },
    };
    const rec = record(
      open({ url: primaryUrl(), searchPath: schemaName, max: options.max ?? 1 }),
      options.mutate ?? envMutation(),
    );
    const db = connect(rec.pool, { schema: gateApp, hookm: [hookm] });
    try {
      await db.connected;
      rec.log.length = 0;
      const env: GateEnv = {
        db,
        rec,
        sql,
        schemaName,
        audits,
        drain() {
          audits.length = 0;
          rec.log.length = 0;
        },
        async rows(table, tenant) {
          const found = await sql.unsafe(
            `select * from ${SQL_NAME[table]} where tenant_id = $1 order by id`,
            [tenant],
          );
          return found.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([name, value]) => [
                camel(name),
                value instanceof Date ? value.toISOString() : value,
              ]),
            ),
          ) as Raw[];
        },
        async snapshot(tenant) {
          const parts = TENANT_TABLES.map(
            (table) =>
              `'${table}', (select coalesce(json_agg(t order by id), '[]'::json) from ${SQL_NAME[table]} t where tenant_id = $1)`,
          );
          const found = await sql.unsafe(
            `select json_build_object(${parts.join(", ")})::text as snap`,
            [tenant],
          );
          return String(found[0]?.snap);
        },
        async clear() {
          for (const table of [...TENANT_TABLES].reverse()) {
            await sql.unsafe(`delete from ${SQL_NAME[table]}`);
          }
          await sql.unsafe("delete from countries");
          env.drain();
        },
      };
      return await fn(env);
    } finally {
      await db.close();
    }
  });
}
