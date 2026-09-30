import { expect, test } from "bun:test";

import {
  isolatedSchemaName,
  openPostgres,
  primaryUrl,
  withPglite,
  withPgliteSchema,
  withPostgres,
  withPostgresSchema,
} from "@okmodel/harness";
import { generateFixture } from "@okmodel/harness/fixtures";

import { catalogFromFixture } from "./fixture.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "./gate.js";
import { mismatchesFor } from "./normalize.js";
import { OBJECT_KINDS, staticNamespace, templateNamespace, type CatalogObject } from "./object.js";
import { renderCatalog, renderDrop, type NamespaceBinding } from "./render.js";
import { roundTrip, type RoundTripReport } from "./round-trip.js";
import { pgliteRunner, postgresRunner } from "./runners.js";
import { extensionCatalog, sampleCatalog } from "./sample.js";
import { quoteIdent, quoteLiteral } from "./sql.js";
import { type SqlRunner } from "./introspect.js";

const SCHEMA_KINDS = OBJECT_KINDS.filter((kind) => kind !== "extension");

type SampleRun = {
  readonly report: RoundTripReport;
  readonly probes: Probes;
};

type Probes = {
  readonly viewColumns: readonly string[];
  readonly triggerFunction: number;
  readonly plpgsqlTable: number;
  readonly atomicTable: number;
  readonly replaceView: boolean;
  readonly replaceMatviewError: string;
  readonly earlyDropFailed: boolean;
  readonly dropOrderError: string;
};

const pgliteSample = once(() =>
  withPgliteSchema(async (db, schema) => runSample(pgliteRunner(db), schema)),
);

for (const kind of SCHEMA_KINDS) {
  test(
    `pglite round trip: ${kind}`,
    async () => {
      const run = await pgliteSample();
      expect(problemsFor(run.report, kind)).toEqual([]);
    },
    { timeout: 60_000 },
  );
}

test(
  "pglite reads pg_depend, refuses to replace a materialized view, and drops in order",
  async () => {
    const run = await pgliteSample();
    expect(run.report.mismatches).toEqual([]);
    expect(run.probes.viewColumns).toEqual(["id", "title"]);
    expect(run.probes.triggerFunction).toBeGreaterThan(0);
    expect(run.probes.plpgsqlTable).toBe(0);
    expect(run.probes.atomicTable).toBeGreaterThan(0);
    expect(run.probes.replaceView).toBe(true);
    expect(run.probes.replaceMatviewError.length).toBeGreaterThan(0);
    expect(run.probes.earlyDropFailed).toBe(true);
    expect(run.probes.dropOrderError).toBe("");
  },
  { timeout: 60_000 },
);

test(
  "pglite round trip keeps a namespace template on the logical identity",
  async () => {
    await withPgliteSchema(async (db, schema) => {
      const report = await roundTrip(
        sampleCatalog(templateNamespace("tenant_{id}")),
        pgliteRunner(db),
        [{ logical: templateNamespace("tenant_{id}"), concrete: schema }],
      );
      expect(report.mismatches).toEqual([]);
    });
  },
  { timeout: 60_000 },
);

test("a view statement fails before its table exists", async () => {
  await withPgliteSchema(async (db, schema) => {
    const namespace = staticNamespace("app");
    const view = renderCatalog(sampleCatalog(namespace), [
      { logical: namespace, concrete: schema },
    ]).find((statement) => statement.startsWith("create view"));
    if (view === undefined) throw new Error("missing view statement");
    let failed = false;
    try {
      await pgliteRunner(db).exec(view);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

test(
  "pglite round trip of the 10-table fixture",
  async () => {
    await withPgliteSchema(async (db, schema) => {
      const namespace = staticNamespace("public");
      const report = await roundTrip(
        catalogFromFixture(generateFixture({ seed: 1, tables: 10 }), namespace),
        pgliteRunner(db),
        [{ logical: namespace, concrete: schema }],
      );
      expect(report.mismatches).toEqual([]);
    });
  },
  { timeout: 60_000 },
);

test("pglite extension round trip", async () => {
  await withPglite(async (db) => {
    const report = await roundTrip(extensionCatalog(), pgliteRunner(db), []);
    expect(report.ok).toBe(false);
    expect(report.mismatches.join("\n")).toMatch(/citext.+is not available/i);
  });
});

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const postgresSample = once(() =>
  withPostgresSchema(async (sql, schema) => runSample(postgresRunner(sql), schema)),
);

for (const kind of SCHEMA_KINDS) {
  postgresTest(decision, `postgres round trip: ${kind}`, async () => {
    const run = await postgresSample();
    expect(problemsFor(run.report, kind)).toEqual([]);
  });
}

postgresTest(
  decision,
  "postgres reads pg_depend, refuses to replace a materialized view, and drops in order",
  async () => {
    const run = await postgresSample();
    expect(run.report.mismatches).toEqual([]);
    expect(run.probes.viewColumns).toEqual(["id", "title"]);
    expect(run.probes.triggerFunction).toBeGreaterThan(0);
    expect(run.probes.plpgsqlTable).toBe(0);
    expect(run.probes.atomicTable).toBeGreaterThan(0);
    expect(run.probes.replaceView).toBe(true);
    expect(run.probes.replaceMatviewError.length).toBeGreaterThan(0);
    expect(run.probes.earlyDropFailed).toBe(true);
    expect(run.probes.dropOrderError).toBe("");
  },
);

postgresTest(
  decision,
  "postgres round trip keeps a namespace template on the logical identity",
  async () => {
    await withPostgresSchema(async (sql, schema) => {
      const report = await roundTrip(
        sampleCatalog(templateNamespace("tenant_{id}")),
        postgresRunner(sql),
        [{ logical: templateNamespace("tenant_{id}"), concrete: schema }],
      );
      expect(report.mismatches).toEqual([]);
    });
  },
);

postgresTest(decision, "postgres round trip of the 10-table fixture", async () => {
  await withPostgresSchema(async (sql, schema) => {
    const namespace = staticNamespace("public");
    const report = await roundTrip(
      catalogFromFixture(generateFixture({ seed: 1, tables: 10 }), namespace),
      postgresRunner(sql),
      [{ logical: namespace, concrete: schema }],
    );
    expect(report.mismatches).toEqual([]);
  });
});

postgresTest(decision, "postgres extension round trip", async () => {
  const name = isolatedSchemaName();
  const admin = openPostgres();
  try {
    await admin.unsafe(`create database ${quoteIdent(name)}`);
    const url = new URL(primaryUrl());
    url.pathname = `/${name}`;
    await withPostgres(async (sql) => {
      const report = await roundTrip(extensionCatalog(), postgresRunner(sql), []);
      expect(report.mismatches).toEqual([]);
    }, url.toString());
  } finally {
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
    await admin.end({ timeout: 5 });
  }
});

function problemsFor(
  report: RoundTripReport,
  kind: (typeof SCHEMA_KINDS)[number],
): readonly string[] {
  return [
    ...report.mismatches.filter(
      (line) => line.startsWith("apply:") || line.startsWith("introspect:"),
    ),
    ...mismatchesFor(report.mismatches, kind),
  ];
}

async function runSample(runner: SqlRunner, schema: string): Promise<SampleRun> {
  const namespace = staticNamespace("app");
  const objects = sampleCatalog(namespace);
  const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
  const report = await roundTrip(objects, runner, bindings);
  const probes = await readProbes(runner, schema, objects, bindings, report);
  return { report, probes };
}

async function readProbes(
  runner: SqlRunner,
  schema: string,
  objects: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  report: RoundTripReport,
): Promise<Probes> {
  const blocked = report.mismatches.some(
    (line) => line.startsWith("apply:") || line.startsWith("introspect:"),
  );
  if (blocked) {
    return {
      viewColumns: [],
      triggerFunction: 0,
      plpgsqlTable: 0,
      atomicTable: 0,
      replaceView: false,
      replaceMatviewError: "",
      earlyDropFailed: false,
      dropOrderError: report.mismatches[0] ?? "apply failed",
    };
  }
  const literal = quoteLiteral(schema);
  const qualified = quoteIdent(schema);
  const viewColumns = (
    await runner.query(`
      select a.attname as name
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass
      join pg_class v on v.oid = r.ev_class
      join pg_class t on t.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
      join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
      join pg_namespace n on n.oid = v.relnamespace
      where n.nspname = ${literal} and v.relname = 'active_tasks' and t.relname = 'tasks' and d.refobjsubid > 0
    `)
  )
    .map((row) => String(row.name))
    .sort();
  const triggerFunction = await count(
    runner,
    `
      select count(*)::int as n
      from pg_depend d
      join pg_trigger t on t.oid = d.objid and d.classid = 'pg_trigger'::regclass
      join pg_proc p on p.oid = d.refobjid and d.refclassid = 'pg_proc'::regclass
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${literal} and t.tgname = 'tasks_touch' and p.proname = 'touch'
    `,
  );
  const plpgsqlTable = await count(
    runner,
    `
      select count(*)::int as n
      from pg_depend d
      join pg_proc p on p.oid = d.objid and d.classid = 'pg_proc'::regclass
      join pg_class c on c.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${literal} and p.proname = 'touch' and c.relname = 'tasks'
    `,
  );
  const atomicTable = await count(
    runner,
    `
      select count(*)::int as n
      from pg_depend d
      join pg_proc p on p.oid = d.objid and d.classid = 'pg_proc'::regclass
      join pg_class c on c.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${literal} and p.proname = 'task_count' and c.relname = 'tasks'
    `,
  );
  let replaceView = false;
  try {
    await runner.exec(
      `create or replace view ${qualified}."active_tasks" as select "id", "title" from ${qualified}."tasks" where "id" > 0`,
    );
    replaceView = true;
  } catch {
    replaceView = false;
  }
  let replaceMatviewError = "";
  try {
    await runner.exec(
      `create or replace materialized view ${qualified}."task_titles" as select "title" from ${qualified}."tasks"`,
    );
  } catch (error) {
    replaceMatviewError = error instanceof Error ? error.message : String(error);
  }
  let earlyDropFailed = false;
  try {
    await runner.exec(`drop table ${qualified}."tasks"`);
  } catch {
    earlyDropFailed = true;
  }
  let dropOrderError = "";
  try {
    for (const statement of renderDrop(objects, bindings)) {
      await runner.exec(statement);
    }
  } catch (error) {
    dropOrderError = error instanceof Error ? error.message : String(error);
  }
  return {
    viewColumns,
    triggerFunction,
    plpgsqlTable,
    atomicTable,
    replaceView,
    replaceMatviewError,
    earlyDropFailed,
    dropOrderError,
  };
}

async function count(runner: SqlRunner, statement: string): Promise<number> {
  const rows = await runner.query(statement);
  const value = rows[0]?.n;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}
