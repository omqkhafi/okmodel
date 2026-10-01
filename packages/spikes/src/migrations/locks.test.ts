/**
 * Lock claims checked against pg_locks, and plpgsql dependencies.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, withPostgres } from "@okmodel/harness";

import { staticNamespace } from "../catalog/object.js";
import { type NamespaceBinding } from "../catalog/render.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { postgresRunner } from "../catalog/runners.js";
import { quoteLiteral } from "../catalog/sql.js";
import { applyAndCompare } from "./apply.js";
import { dependencyPair, migrationPair } from "./generate.js";
import { planMigration } from "./plan.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

function bindingsFor(schema: string): readonly NamespaceBinding[] {
  return [{ logical: staticNamespace("app"), concrete: schema }];
}

postgresTest(
  decision,
  "each planned step's lock matches pg_locks",
  async () => {
    await withPostgres(async (sql) => {
      const schema = isolatedSchemaName();
      const pair = migrationPair(3);
      const bindings = bindingsFor(schema);
      const plan = planMigration([], pair.before, bindings);
      await sql.unsafe(`create schema ${schema}`);
      await sql.unsafe(`set search_path to ${schema}`);
      const mismatches: string[] = [];
      try {
        for (const step of plan.steps) {
          await sql.unsafe("begin");
          await sql.unsafe(step.sql);
          const rows = await sql.unsafe<Record<string, unknown>[]>(
            `select c.relname as relation, l.mode as mode
             from pg_locks l
             join pg_class c on c.oid = l.relation
             join pg_namespace n on n.oid = c.relnamespace
             where l.pid = pg_backend_pid() and l.locktype = 'relation' and n.nspname = ${quoteLiteral(schema)}`,
          );
          await sql.unsafe("commit");
          const observed = rows.map((row) => `${String(row.relation)}:${String(row.mode)}`);
          if (step.lock.mode === "none") {
            if (observed.length > 0) {
              mismatches.push(`${step.sql} claimed no relation lock, saw ${observed.join(", ")}`);
            }
            continue;
          }
          const expected = `${step.lock.relation}:${step.lock.mode}`;
          if (!observed.includes(expected)) {
            mismatches.push(
              `${step.sql} claimed ${expected}, saw ${observed.join(", ") || "nothing"}`,
            );
          }
          if (step.lock.blocksReads !== (step.lock.mode === "AccessExclusiveLock")) {
            mismatches.push(`${step.sql} blocksReads does not follow the mode`);
          }
          const blocksWrites =
            step.lock.mode === "AccessExclusiveLock" ||
            step.lock.mode === "ShareLock" ||
            step.lock.mode === "ShareRowExclusiveLock";
          if (step.lock.blocksWrites !== blocksWrites) {
            mismatches.push(`${step.sql} blocksWrites does not follow the mode`);
          }
        }
      } finally {
        await sql.unsafe("set search_path to public");
        await sql.unsafe(`drop schema if exists ${schema} cascade`);
      }
      expect(mismatches).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  decision,
  "a missing plpgsql dependency leaves a function that fails after the table is dropped",
  async () => {
    await withPostgres(async (sql) => {
      const runner = postgresRunner(sql);
      const missing = dependencyPair(false);
      const report = await applyAndCompare(
        runner,
        isolatedSchemaName(),
        missing.before,
        missing.after,
        bindingsFor,
      );
      expect(report.structural).toEqual([]);
      const schema = isolatedSchemaName();
      await sql.unsafe(`create schema ${schema}`);
      await sql.unsafe(`set search_path to ${schema}`);
      try {
        const { renderCatalog } = await import("../catalog/render.js");
        for (const statement of renderCatalog(missing.before, bindingsFor(schema))) {
          await sql.unsafe(statement);
        }
        await sql.unsafe(`set statement_timeout = '3s'`);
        await sql.unsafe(`drop table ${quoteIdentSafe(schema)}.${quoteIdentSafe("tasks")}`);
        const stillThere = await sql.unsafe<Record<string, unknown>[]>(
          `select p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = ${quoteLiteral(schema)} and p.proname = 'task_rows'`,
        );
        expect(stillThere).toHaveLength(1);
        let failed = false;
        try {
          await sql.unsafe(`select ${quoteIdentSafe(schema)}.task_rows()`);
        } catch (error) {
          failed = true;
          const message = error instanceof Error ? error.message : String(error);
          expect(message.toLowerCase()).toContain("tasks");
        }
        expect(failed).toBe(true);
      } finally {
        await sql.unsafe("set search_path to public");
        await sql.unsafe(`drop schema if exists ${schema} cascade`);
      }

      const declared = dependencyPair(true);
      const declaredReport = await applyAndCompare(
        runner,
        isolatedSchemaName(),
        declared.before,
        declared.after,
        bindingsFor,
      );
      expect(declaredReport.structural).toEqual([]);
      expect(declaredReport.plan.steps.some((step) => step.sql.startsWith("drop function"))).toBe(
        true,
      );
    });
  },
  60_000,
);

function quoteIdentSafe(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
