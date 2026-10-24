/**
 * `take()` refuses an empty lowering and a class that does not match the kind (N-124).
 */

import { expect } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { ddlStep } from "../src/dialects/ddl-step.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import type { LogicalChange } from "../src/dialects/ddl.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { postgresDialect } from "../src/tooling/migrate/postgres-dialect.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

const before = catalog([]);
const after = schema({
  tables: [table("items", { id: t.integer().primaryKey() })],
}).catalog;

postgresTest(
  gate,
  "an empty lowering and a wrong step class are OKM1559, and a real plan still applies",
  async () => {
    const empty = caught(() =>
      planMigration({ before, after, name: "empty" }, { ...postgresDialect, lower: () => [] }),
    );
    expect(empty).toBeInstanceOf(OkmError);
    if (empty instanceof OkmError) expect(empty.code).toBe("OKM1559");

    const lied = caught(() =>
      planMigration(
        { before, after, name: "class" },
        {
          ...postgresDialect,
          lower(change: LogicalChange) {
            return postgresDialect
              .lower(change)
              .map((step) =>
                step.kind === "create-table" ? { ...step, class: "contract" as const } : step,
              );
          },
        },
      ),
    );
    expect(lied).toBeInstanceOf(OkmError);
    if (lied instanceof OkmError) {
      expect(lied.code).toBe("OKM1559");
      expect(lied.message).toContain("create-table");
    }

    const blank = caught(() =>
      planMigration(
        { before, after, name: "blank" },
        {
          ...postgresDialect,
          lower: () => [ddlStep("", "create-table", "ddl", "ACCESS EXCLUSIVE")],
        },
      ),
    );
    expect(blank).toBeInstanceOf(OkmError);
    if (blank instanceof OkmError) expect(blank.code).toBe("OKM1559");

    const planned = planMigration({ before, after, schema: "public", name: "init" });
    expect(planned.steps.length).toBeGreaterThan(0);
    await withPostgresSchema(async (sql, schemaName) => {
      const placed = planMigration({ before, after, schema: schemaName, name: "init" });
      await applyTarget({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [
          {
            id: "0001_init",
            catalogHash: "hash-init",
            steps: placed.steps,
          } satisfies StoredMigration,
        ],
      });
      const tables = await sql<{ name: string }[]>`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${schemaName} and c.relkind = 'r'
      `;
      expect(tables.map((row) => row.name)).toContain("items");
    });
  },
  60_000,
);

function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}
