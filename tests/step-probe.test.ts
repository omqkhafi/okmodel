/**
 * Declared `-- probe:` on a committed step.
 *
 * Parse and print, the two lint codes, and a fake connection for the
 * Postgres probe. A built-in probe still wins.
 */

import { expect, test } from "bun:test";

import type { DriverConnection, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { sessionFailure } from "../src/tooling/migrate/lost.js";
import { enumColumn } from "../src/dialects/pg/enum.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { planDocument, type PlanDocument } from "../src/tooling/migrate/plan-json.js";
import { postgresStepEngine } from "../src/tooling/migrate/pg-probe.js";
import {
  PartialCleanupError,
  resumeCommittedStep,
  type CommittedStep,
} from "../src/tooling/migrate/step-engine.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";
import { stepSqlHash } from "../src/tooling/migrate/step-engine.js";

const empty = schema({ tables: [] }).catalog;

const INDEX_BUILD_WAIT =
  'Index "mine" is being built by another session. Wait for it to finish, then apply again.';

const probeSql = "select note = 'a;b' and note = '-- probe: no'";

test("a probe round-trips, including a quoted semicolon, a comment-like string, and CRLF", () => {
  const step: PlanStep = {
    sql: "vacuum analyze notes",
    class: "expand",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: false,
    probe: probeSql,
  };
  const plan = { name: "hand", class: "expand" as const, steps: [step] };
  const text = formatPlan(plan);
  expect(text).toContain(`-- probe: ${probeSql}`);
  expect(formatPlan(parsePlan(text))).toBe(text);
  expect(parsePlan(text.replaceAll("\n", "\r\n"))).toEqual(parsePlan(text));
  expect(parsePlan(text.replaceAll("\n", "\r")).steps[0]?.probe).toBe(probeSql);
  const parsed = parsePlan(text).steps[0];
  expect(parsed?.probe).toBe(probeSql);
  expect(stepSqlHash(parsed?.sql ?? "")).toBe(stepSqlHash(step.sql));
  const withProbe = documentOf(step);
  const { probe: declared, ...withoutProbe } = step;
  expect(declared).toBe(probeSql);
  const without = documentOf(withoutProbe);
  expect(withProbe.steps[0]?.probe).toBe(probeSql);
  expect(without.steps[0]?.probe).toBeUndefined();
  expect(withProbe.planHash).toBe(without.planHash);
});

test("OKM1557 fires only when a raw concurrent index cannot be parsed", () => {
  expect(codes("create index concurrently idx on t (id)")).not.toContain("OKM1557");
  expect(codes("create index concurrently on t (id)")).toContain("OKM1557");
  expect(codes("-- transactional: false\ncreate table notes (id int)")).toContain("OKM1557");
  expect(codes("create table notes (id int)")).not.toContain("OKM1557");
  expect(
    codes("-- probe: select true\n-- transactional: false\ncreate table notes (id int)"),
  ).not.toContain("OKM1557");
  expect(
    codes("-- okm-allow OKM1557: reviewed\n-- transactional: false\nvacuum analyze notes"),
  ).not.toContain("OKM1557");
  expect(codes("-- okm-allow OKM1557:\n-- transactional: false\nvacuum analyze notes")).toContain(
    "OKM1557",
  );
  expect(codes("-- okm-allow OKM1557:\n-- transactional: false\nvacuum analyze notes")).toContain(
    "OKM1510",
  );
});

test("planner steps that already have a probe are not OKM1557", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
  const indexed = table(
    "tasks",
    { id: t.identity(), title: t.text() },
    { indexes: (columns) => [index(columns.title)] },
  );
  const added = planMigration({
    before: before.catalog,
    after: schema({ tables: [indexed] }).catalog,
    name: "index",
  });
  expect(
    lintPlan(added, before.catalog, schema({ tables: [indexed] }).catalog).map((item) => item.code),
  ).not.toContain("OKM1557");
  const colored = table("tasks", {
    id: t.identity(),
    status: enumColumn("color", ["red"]),
  });
  const widened = table("tasks", {
    id: t.identity(),
    status: enumColumn("color", ["red", "blue"]),
  });
  const values = planMigration({
    before: schema({ tables: [colored] }).catalog,
    after: schema({ tables: [widened] }).catalog,
    name: "color",
  });
  expect(
    lintPlan(values, schema({ tables: [colored] }).catalog, schema({ tables: [widened] }).catalog)
      .map((item) => item.code)
      .includes("OKM1557"),
  ).toBe(false);
  expect(
    added.steps.some((step) => step.kind === "create-index" && step.transactional === false),
  ).toBe(true);
});

test("OKM1558 refuses an empty, multi-statement, writing, or transactional probe", () => {
  expect(codes("-- probe:\n-- transactional: false\nvacuum analyze notes")).toContain("OKM1558");
  expect(
    codes("-- probe: delete from notes\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
  expect(
    codes("-- probe: select true; select false\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
  expect(
    codes(
      "-- probe: with x as (insert into notes values (1) returning id) select id is not null\n-- transactional: false\nvacuum analyze notes",
    ),
  ).toContain("OKM1558");
  expect(codes("-- probe: select true\ncreate table notes (id int)")).toContain("OKM1558");
  expect(
    codes(`-- probe: ${probeSql}\n-- transactional: false\nvacuum analyze notes`),
  ).not.toContain("OKM1558");
  expect(
    codes("-- probe: select true;\n-- transactional: false\nvacuum analyze notes"),
  ).not.toContain("OKM1558");
  expect(
    codes(
      "-- okm-allow OKM1558: reviewed\n-- probe: delete from notes\n-- transactional: false\nvacuum analyze notes",
    ),
  ).not.toContain("OKM1558");
  expect(
    codes("-- okm-allow OKM1558:\n-- probe:\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
});

test("a declared probe reads one boolean inside a read-only transaction", async () => {
  expect(await verdict([["t"]])).toBe("applied");
  expect(await verdict([["true"]])).toBe("applied");
  expect(await verdict([["f"]])).toBe("absent");
  expect(await verdict([["false"]])).toBe("absent");
  expect(await verdict([[null]])).toBe("unknown");
  expect(await verdict([["t"], ["t"]])).toBe("unknown");
  expect(await verdict([["yes"]])).toBe("unknown");
  expect(await verdict([["t", "extra"]])).toBe("unknown");
  const failed = scripted(() => {
    throw new Error("probe failed");
  });
  expect(await failed.engine.probe()).toBe("unknown");
  expect(failed.calls).toEqual(["begin read only", "select true", "rollback"]);
});

test("a built-in probe wins over a declared one and a declared probe has no cleanup", async () => {
  const calls: string[] = [];
  const connection = {
    execute(text: string) {
      calls.push(text);
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const engine = postgresStepEngine(
    connection,
    {
      kind: "raw-sql",
      sql: "create index concurrently idx on items (id)",
      lockTimeoutMs: 1_000,
      probe: "select true",
    },
    () => Promise.resolve(),
  );
  expect(engine.probed).toBe(true);
  expect(await engine.probe()).toBe("absent");
  expect(calls.some((text) => text.includes("begin read only"))).toBe(false);
  expect(calls.some((text) => text.includes("pg_class"))).toBe(true);
  const declared = scripted(() => done([["t"]]));
  await declared.engine.cleanup();
  expect(declared.calls).toEqual([]);
});

test("cleanup names an unqualified mixed-case index, an escaped quote, and another schema", async () => {
  expect(await dropSql('create index concurrently MixedCase on "app"."tasks" ("title")')).toBe(
    'drop index concurrently if exists "app"."mixedcase"',
  );
  expect(await dropSql('create index concurrently "a""b" on "app"."tasks" (id)')).toBe(
    'drop index concurrently if exists "app"."a""b"',
  );
  expect(await dropSql('create index concurrently "other"."idx" on "other"."tasks" (id)')).toBe(
    'drop index concurrently if exists "other"."idx"',
  );
});

test("cleanup matches this index and not another build on the same table", async () => {
  const sql = 'create index concurrently mine on "app"."tasks" (id)';
  const seen: string[] = [];
  const connection = {
    execute(text: string, params?: readonly unknown[]) {
      seen.push(text);
      if (text.includes("pg_stat_activity")) {
        const first = params?.[0];
        const pattern = typeof first === "string" ? first : "";
        expect(pattern).toContain("mine");
        expect(pattern).not.toContain("tasks");
        return Promise.resolve(done([]));
      }
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  await postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
    Promise.resolve(),
  ).cleanup();
  expect(seen.some((text) => text.startsWith("drop index concurrently"))).toBe(true);

  const blocked = {
    execute(text: string) {
      if (text.includes("pg_stat_activity")) return Promise.resolve(done([["42"]]));
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const stopped = await rejection(
    postgresStepEngine(blocked, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
      Promise.resolve(),
    ).cleanup(),
  );
  expect(stopped).toBeInstanceOf(PartialCleanupError);
  if (stopped instanceof PartialCleanupError) {
    expect(stopped.detail).toContain(INDEX_BUILD_WAIT);
    expect(stopped.fix).toBe(INDEX_BUILD_WAIT);
    expect(stopped.fix).not.toContain("DROP INDEX");
    expect(stopped.detail.split(INDEX_BUILD_WAIT).length - 1).toBe(1);
  }
});

test("cleanup waits when only pg_stat_progress_create_index shows the build", async () => {
  const sql = 'create index concurrently mine on "app"."tasks" (id)';
  const seen: string[] = [];
  const connection = {
    execute(text: string) {
      seen.push(text);
      if (text.includes("pg_stat_progress_create_index")) return Promise.resolve(done([["1"]]));
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const stopped = await rejection(
    postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
      Promise.resolve(),
    ).cleanup(),
  );
  expect(stopped).toBeInstanceOf(PartialCleanupError);
  if (stopped instanceof PartialCleanupError) {
    expect(stopped.fix).toBe(INDEX_BUILD_WAIT);
  }
  expect(seen.some((text) => text.startsWith("drop index concurrently"))).toBe(false);
});

test("cleanup checks again immediately before the drop", async () => {
  const sql = 'create index concurrently mine on "app"."tasks" (id)';
  let activity = 0;
  const seen: string[] = [];
  const connection = {
    execute(text: string) {
      seen.push(text);
      if (text.includes("pg_stat_activity")) {
        activity += 1;
        return Promise.resolve(activity >= 2 ? done([["7"]]) : done([]));
      }
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const stopped = await rejection(
    postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
      Promise.resolve(),
    ).cleanup(),
  );
  expect(stopped).toBeInstanceOf(PartialCleanupError);
  if (stopped instanceof PartialCleanupError) expect(stopped.fix).toBe(INDEX_BUILD_WAIT);
  expect(seen.some((text) => text.startsWith("drop index concurrently"))).toBe(false);
});

test("another session's index build is one sentence, once", async () => {
  const sql = 'create index concurrently mine on "app"."tasks" (id)';
  const committed: CommittedStep = {
    migrationId: "0002_idx",
    stepIndex: 0,
    kind: "create-index",
    sql,
    sqlHash: stepSqlHash(sql),
    stepClass: "expand",
    catalogHash: "hash",
    finishes: false,
  };
  const connection = {
    execute(text: string) {
      if (text.includes("indisvalid")) return Promise.resolve(done([["f", null, "app"]]));
      if (text.includes("pg_stat_activity")) return Promise.resolve(done([["42"]]));
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const error = await rejection(
    resumeCommittedStep(
      committed,
      {
        async read() {
          return {
            migrationId: "0002_idx",
            stepIndex: 0,
            kind: "create-index",
            sqlHash: stepSqlHash(sql),
            state: "failed",
            attempt: 1,
          };
        },
        async start() {},
        async fail() {},
        async complete() {},
      },
      postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
        Promise.reject(new Error('could not create index "mine"')),
      ),
      {
        retries: 0,
        wrap: (caught) =>
          new OkmError(
            "invalid",
            'Migration 0002_idx failed at step 1: could not create index "mine"',
            {
              cause: caught,
            },
          ),
      },
    ),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.message.split(INDEX_BUILD_WAIT).length - 1).toBe(1);
    expect(error.fix.summary).toBe(INDEX_BUILD_WAIT);
    expect(error.message).not.toContain("partial index will be dropped and rebuilt");
    expect(error.message).not.toContain("DROP INDEX");
  }
});

test("a concurrent index failure ends the driver sentence with a period", async () => {
  const sql = 'create unique index concurrently mine on "app"."tasks" (id)';
  const cause = 'could not create unique index "mine"';
  const committed: CommittedStep = {
    migrationId: "0002_idx",
    stepIndex: 0,
    kind: "create-index",
    sql,
    sqlHash: stepSqlHash(sql),
    stepClass: "expand",
    catalogHash: "hash",
    finishes: false,
  };
  const connection = {
    execute() {
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const error = await rejection(
    resumeCommittedStep(
      committed,
      {
        async read() {
          return {
            migrationId: "0002_idx",
            stepIndex: 0,
            kind: "create-index",
            sqlHash: stepSqlHash(sql),
            state: "failed",
            attempt: 1,
          };
        },
        async start() {},
        async fail() {},
        async complete() {},
      },
      postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
        Promise.reject(new Error(cause)),
      ),
      {
        retries: 0,
        wrap: (caught) =>
          new OkmError("invalid", `Migration 0002_idx failed at step 1: ${cause}`, {
            cause: caught,
          }),
      },
    ),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.message).toContain('could not create unique index "mine".');
  }
});

test("a lost connection during create index concurrently names the index", async () => {
  const sql = 'create index concurrently "a""b" on "app"."tasks" (id)';
  const closed = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
  const connection = {
    execute() {
      throw closed;
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const committed: CommittedStep = {
    migrationId: "0002_idx",
    stepIndex: 0,
    kind: "create-index",
    sql,
    sqlHash: stepSqlHash(sql),
    stepClass: "expand",
    catalogHash: "hash",
    finishes: false,
  };
  const error = await rejection(
    resumeCommittedStep(
      committed,
      {
        async read() {
          return undefined;
        },
        async start() {},
        async fail() {},
        async complete() {},
      },
      postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
        Promise.reject(closed),
      ),
      {
        retries: 0,
        wrap: (caught) => {
          const lost = sessionFailure(caught);
          if (lost !== undefined) {
            return new OkmError(
              "unavailable",
              `Migration 0002_idx failed at step 1: ${lost.message}`,
              {
                kind: lost.kind,
                cause: caught,
                fix: lost.fix,
              },
            );
          }
          return new OkmError("invalid", "failed");
        },
      },
    ),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.message).toContain('Index "app"."a""b" may be INVALID.');
    expect(error.fix.summary).toContain('DROP INDEX CONCURRENTLY "app"."a""b"');
  }
});

async function dropSql(sql: string): Promise<string> {
  const calls: string[] = [];
  const connection = {
    execute(text: string) {
      calls.push(text);
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  await postgresStepEngine(connection, { kind: "create-index", sql, lockTimeoutMs: 1_000 }, () =>
    Promise.resolve(),
  ).cleanup();
  const drop = calls.find((text) => text.startsWith("drop index"));
  if (drop === undefined) throw new Error(calls.join("\n"));
  return drop;
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return undefined;
}

function documentOf(step: PlanStep): PlanDocument {
  return planDocument({ name: "hand", class: "expand", steps: [step] }, []);
}

function codes(sql: string): readonly string[] {
  return lintPlan(parsePlan(`-- name: hand\n\n${sql};\n`), empty, empty).map((item) => item.code);
}

async function verdict(rows: readonly (readonly (string | null)[])[]): Promise<string> {
  const world = scripted(() => done(rows));
  const value = await world.engine.probe();
  expect(world.calls).toEqual(["begin read only", "select true", "rollback"]);
  return value;
}

function scripted(reply: () => ExecuteResult): {
  engine: ReturnType<typeof postgresStepEngine>;
  calls: string[];
} {
  const calls: string[] = [];
  const connection = {
    execute(text: string) {
      calls.push(text);
      if (text === "begin read only" || text === "rollback") return Promise.resolve(done([]));
      try {
        return Promise.resolve(reply());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("probe failed"));
      }
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  return {
    calls,
    engine: postgresStepEngine(
      connection,
      { kind: "raw-sql", sql: "vacuum analyze notes", lockTimeoutMs: 1_000, probe: "select true" },
      () => Promise.resolve(),
    ),
  };
}

function done(rows: readonly (readonly (string | null)[])[]): ExecuteResult {
  return { rows, count: rows.length, notices: [] };
}
