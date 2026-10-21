/**
 * A declared probe on Postgres.
 *
 * A crash after the DDL and before the history row is applied on the next
 * apply, which runs no SQL. A crash before the DDL is absent, so the step
 * runs. `resolve --applied` uses the same probe and refuses when it is false.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { formatPlan, type PlanStep } from "../src/tooling/migrate/plan.js";
import { resolveProject } from "../src/tooling/migrate/resolve.js";
import { StepBoundaryStop, type StepBoundary } from "../src/tooling/migrate/step-engine.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

postgresTest(
  gate,
  "a declared probe skips SQL after the DDL and runs it when the DDL did not",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const step = probeStep(schemaName);
      const crashed = await catchError(() => applyTo(schemaName, [migration(step)], "after-ddl"));
      expect(crashed).toBeInstanceOf(StepBoundaryStop);
      const present = await sql<{ n: string }[]>`
        select count(*)::text as n
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = ${schemaName} and c.relname = 'probe_notes'
      `;
      expect(present[0]?.n).toBe("1");
      const history = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(history[0]?.n).toBe("0");
      await applyTo(schemaName, [migration(step)]);
      const again = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(again[0]?.n).toBe("1");
      const steps = await sql<{ n: string }[]>`select count(*)::text as n from okm_steps`;
      expect(steps[0]?.n).toBe("0");
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a declared probe says absent before the DDL, and resolve refuses to record it",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const cwd = project(schemaName);
      const step = probeStep(schemaName);
      writeStep(cwd, step);
      const crashed = await catchError(() =>
        applyTo(schemaName, [migration(step)], "after-started"),
      );
      expect(crashed).toBeInstanceOf(StepBoundaryStop);
      const absent = await sql<{ n: string }[]>`
        select count(*)::text as n
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = ${schemaName} and c.relname = 'probe_notes'
      `;
      expect(absent[0]?.n).toBe("0");
      const refused = await catchError(() =>
        resolveProject(cwd, {
          allowProtected: false,
          allowPooler: false,
          applied: true,
          retry: false,
          acceptUnverified: false,
          step: "0001_init:0",
        }),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1554");
      const still = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(still[0]?.n).toBe("0");
      await applyTo(schemaName, [migration(step)]);
      const created = await sql<{ n: string }[]>`
        select count(*)::text as n
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = ${schemaName} and c.relname = 'probe_notes'
      `;
      expect(created[0]?.n).toBe("1");
      const done = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(done[0]?.n).toBe("1");
    });
  },
  40_000,
);

function probeStep(schemaName: string): PlanStep {
  const probe = `select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${schemaName}' and c.relname = 'probe_notes')`;
  return {
    sql: `create table "${schemaName}".probe_notes (id integer)`,
    class: "expand",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: false,
    probe,
  };
}

function migration(step: PlanStep): StoredMigration {
  return { id: "0001_init", catalogHash: "hash", steps: [step] };
}

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  failAt?: StepBoundary,
) {
  return applyTarget({
    url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    migrations,
    ...(failAt !== undefined ? { failAt } : {}),
  });
}

function project(schemaName: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-probe-"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `export default { schema: "./schema.ts", namespace: ${JSON.stringify(schemaName)}, database: { url: ${JSON.stringify(url)} } };\n`,
  );
  writeFileSync(join(cwd, "schema.ts"), "export {}\n");
  return cwd;
}

function writeStep(cwd: string, step: PlanStep): void {
  mkdirSync(join(cwd, "migrations"), { recursive: true });
  writeFileSync(
    join(cwd, "migrations", "0001_init.sql"),
    formatPlan({ name: "0001_init", class: "expand", steps: [step] }),
  );
  writeFileSync(join(cwd, "migrations", "0001_init.catalog.json"), serializeCatalog(catalog([])));
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}
