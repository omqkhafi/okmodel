/**
 * `blocking` and `rewrite` steps: the file format, the plan estimate, and the
 * apply-time refusal over 100,000 rows.
 *
 * The refusal tests run against a real Postgres. The row count is taken on the
 * target when apply starts, so a table that grew after the plan was printed is
 * counted as it is then.
 */

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { errorBody } from "../src/tooling/errors/body.js";
import { applyTarget, type ApplyReport } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import {
  formatPlan,
  parsePlan,
  type MigrationPlan,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";
import { planDocument } from "../src/tooling/migrate/plan-json.js";
import {
  BLOCKING_ROWS,
  countTables,
  durationPhrase,
  estimateMs,
  weightPhrase,
} from "../src/tooling/migrate/weight.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

test("step.blocking: a weight round-trips through the migration file and the old text still parses", () => {
  const plan: MigrationPlan = {
    name: "weights",
    class: "expand",
    steps: [
      {
        ...step('alter table "public"."t" add constraint t_ex exclude using btree (id with =)'),
        weight: "blocking",
        tables: ["t"],
      },
      {
        ...step('alter table "public"."t" alter column n type bigint'),
        weight: "rewrite",
        tables: ["t"],
      },
      step('alter table "public"."t" add column note text'),
    ],
  };
  const text = formatPlan(plan);
  expect(text).toContain("-- weight: blocking");
  expect(text).toContain("-- weight: rewrite");
  expect(text.match(/-- weight:/g)).toHaveLength(2);
  const back = parsePlan(text);
  expect(back.steps.map((item) => item.weight)).toEqual(["blocking", "rewrite", undefined]);
  // A line the reader does not know is ignored, so the step still reads.
  expect(
    parsePlan(text.replace("-- weight: rewrite", "-- weight: heavy")).steps[1]?.weight,
  ).toBeUndefined();
});

test("step.blocking: the estimate is about 45 s per million rows for blocking and 1.3 s for a rewrite", () => {
  expect(estimateMs("blocking", 1_000_000)).toBe(45_000);
  expect(estimateMs("rewrite", 1_000_000)).toBe(1_300);
  expect(estimateMs("blocking", 100_000)).toBe(4_500);
  expect(durationPhrase(4_500)).toBe("about 4.5 s");
  expect(durationPhrase(400)).toBe("under 1 s");
  expect(durationPhrase(270_000)).toBe("about 4.5 min");
  expect(weightPhrase("blocking", "t", { rows: 2_000_000, least: false })).toBe(
    "blocking step on t, 2M rows: about 1.5 min (an estimate, not a measurement)",
  );
  expect(weightPhrase("rewrite", "t", { rows: 100_001, least: true })).toContain(
    "100,001 or more rows",
  );
  expect(weightPhrase("blocking", "t", undefined)).toContain("45 s per million rows (an estimate)");
});

test("step.blocking: plan --json carries the weight, the rows, and the estimate", () => {
  const plan: MigrationPlan = {
    name: "weights",
    class: "expand",
    steps: [
      { ...step("alter table t alter column n type bigint"), weight: "rewrite", tables: ["t"] },
      step("alter table t add column note text"),
    ],
  };
  const doc = planDocument(plan, [], undefined, undefined, undefined, (item) =>
    item.weight === undefined ? undefined : { estimatedRows: 2_000_000, estimateMs: 2_600 },
  );
  expect(doc.steps[0]?.weight).toBe("rewrite");
  expect(doc.steps[0]?.estimatedRows).toBe(2_000_000);
  expect(doc.steps[0]?.estimateMs).toBe(2_600);
  expect(doc.steps[1]).not.toHaveProperty("weight");
  expect(doc.steps[1]).not.toHaveProperty("estimateMs");
  expect(doc.steps[0]?.class).toBe("expand");
});

postgresTest(
  gate,
  "proof:step.blocking",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 150_000);
      const error = await failure(schemaName, [blocking(schemaName)]);
      expect(error.code).toBe("OKM1847");
      expect(error.message.endsWith("Nothing was changed.")).toBe(true);
      expect(error.message).toContain("0001_exclude step 1");
      expect(error.message).toContain("blocking step on big");
      expect(error.message).toContain("an estimate, not a measurement");
      // The count stops at its bound, so the estimate says "at least".
      expect(error.message).toContain("100,001 or more rows: at least about 4.5 s");
      expect(error.fix.summary).toContain("--allow-blocking");
      expect(error.fix.summary).toContain("lock timeout covers waiting for the lock");
      expect(error.retryable).toBe(false);
      expect(await constraints(sql, schemaName)).toEqual([]);
      expect(await ledger(sql, schemaName)).toBeNull();
      const body = errorBody(error);
      expect(body.code).toBe("OKM1847");
      expect(body.retryable).toBe(false);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: --allow-blocking runs the step, and a second apply has nothing left to refuse",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 150_000);
      const report = await applyTo(schemaName, [blocking(schemaName)], true);
      expect(report.applied).toEqual(["0001_exclude"]);
      expect(await constraints(sql, schemaName)).toEqual(["big_ex"]);
      const again = await applyTo(schemaName, [blocking(schemaName)], false);
      expect(again.applied).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: a table at or under 100,000 rows runs with no flag",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, BLOCKING_ROWS);
      const report = await applyTo(schemaName, [blocking(schemaName)], false);
      expect(report.applied).toEqual(["0001_exclude"]);
      expect(await constraints(sql, schemaName)).toEqual(["big_ex"]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: a table that crosses the limit between plan and apply stops apply",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 10);
      // The plan sees a small table.
      const planned = await countTables((text, params) => run(sql, text, params), schemaName, [
        "big",
      ]);
      expect(planned.get("big")).toEqual({ rows: 10, least: false });
      // A concurrent writer fills it after the plan was printed. ANALYZE ran while it was small,
      // so pg_class.reltuples is stale and says 10.
      await sql.unsafe(`analyze ${q(schemaName)}.big`);
      await sql.unsafe(
        `insert into ${q(schemaName)}.big select g + 1000000 from generate_series(1, 150000) g`,
      );
      const error = await failure(schemaName, [blocking(schemaName)]);
      expect(error.code).toBe("OKM1847");
      expect(error.message).toContain("Nothing was changed.");
      expect(await constraints(sql, schemaName)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: a rewrite step over the limit stops with its own estimate",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 150_000);
      const error = await failure(schemaName, [rewrite(schemaName)]);
      expect(error.code).toBe("OKM1847");
      expect(error.message).toContain("rewrite step on big");
      expect(error.message).toContain("under 1 s");
      expect(await columnType(sql, schemaName)).toBe("integer");
      const report = await applyTo(schemaName, [rewrite(schemaName)], true);
      expect(report.applied).toEqual(["0001_type"]);
      expect(await columnType(sql, schemaName)).toBe("bigint");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: a weighted step that names no readable table is refused, not skipped",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 10);
      const unreadable = fromFile("0001_unqualified", [
        { ...step("alter table big alter column id type bigint"), weight: "rewrite" },
      ]);
      const error = await failure(schemaName, [unreadable]);
      expect(error.code).toBe("OKM1847");
      expect(error.message).toContain("names no table I can read");
      expect(await columnType(sql, schemaName)).toBe("integer");
      const report = await applyTo(schemaName, [unreadable], true);
      expect(report.applied).toEqual(["0001_unqualified"]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "step.blocking: a step with no weight never asks for the flag",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await table(sql, schemaName, 150_000);
      const plain = migration("0001_plain", [
        { ...step(`alter table ${q(schemaName)}.big add column note text`), tables: ["big"] },
      ]);
      const report = await applyTo(schemaName, [plain], false);
      expect(report.applied).toEqual(["0001_plain"]);
    });
  },
  60_000,
);

/** A migration the way apply reads it: from file text, which keeps no table list. */
function fromFile(id: string, steps: readonly PlanStep[]): StoredMigration {
  const parsed = parsePlan(formatPlan({ name: id, class: "expand", steps }));
  expect(parsed.steps.every((item) => item.tables === undefined)).toBe(true);
  return migration(id, parsed.steps);
}

function blocking(schemaName: string): StoredMigration {
  return fromFile("0001_exclude", [
    {
      ...step(
        `alter table ${q(schemaName)}."big" add constraint big_ex exclude using btree (id with =)`,
      ),
      weight: "blocking",
    },
  ]);
}

function rewrite(schemaName: string): StoredMigration {
  return fromFile("0001_type", [
    {
      ...step(`alter table ${q(schemaName)}."big" alter column id type bigint`),
      weight: "rewrite",
    },
  ]);
}

async function table(sql: Sql, schemaName: string, rows: number): Promise<void> {
  await sql.unsafe(`create table ${q(schemaName)}.big (id integer not null)`);
  if (rows > 0) {
    await sql.unsafe(
      `insert into ${q(schemaName)}.big select g from generate_series(1, ${String(rows)}) g`,
    );
  }
}

async function constraints(sql: Sql, schemaName: string): Promise<readonly string[]> {
  const rows = await sql.unsafe(
    `select conname from pg_constraint where conrelid = '${schemaName}.big'::regclass and contype = 'x' order by 1`,
  );
  return rows.map((row) => String(row.conname));
}

async function columnType(sql: Sql, schemaName: string): Promise<string> {
  const rows = await sql.unsafe(
    `select data_type from information_schema.columns where table_schema = '${schemaName}' and table_name = 'big'`,
  );
  return String(rows[0]?.data_type);
}

async function ledger(sql: Sql, schemaName: string): Promise<unknown> {
  const rows = await sql.unsafe(`select to_regclass('${schemaName}.okm_history')::text as t`);
  return rows[0]?.t ?? null;
}

async function run(
  sql: Sql,
  text: string,
  params?: readonly string[],
): Promise<{ readonly rows: readonly (readonly (string | null)[])[] }> {
  const rows = await sql.unsafe(text, params === undefined ? [] : [...params]).values();
  return { rows: rows.map((row) => row.map((cell) => (cell === null ? null : String(cell)))) };
}

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  allowBlocking: boolean,
): Promise<ApplyReport> {
  return applyTarget({
    url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    migrations,
    ...(allowBlocking ? { allowBlocking: true } : {}),
  });
}

async function failure(
  schemaName: string,
  migrations: readonly StoredMigration[],
): Promise<OkmError> {
  try {
    await applyTo(schemaName, migrations, false);
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("apply was expected to refuse");
}

function migration(id: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: `hash-${id}`, steps };
}

function step(sql: string): PlanStep {
  return { sql, class: "expand", action: "ddl", lock: "ACCESS EXCLUSIVE", transactional: true };
}

function q(name: string): string {
  return `"${name}"`;
}
