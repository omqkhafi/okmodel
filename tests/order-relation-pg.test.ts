/**
 * `orderBy` on a relation: one left join, or a to-many count.
 *
 * The related table's tenant predicate and archive filter sit on the join.
 * A missing related row stays in the result. Real Postgres.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { many, one, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const projects = table(
  "projects",
  {
    id: text().primaryKey(),
    name: text(),
    secret: text().nullable().hidden(),
    code: text().nullable().hidden({ filterable: true }),
  },
  {
    traits: [archivable()],
    relations: { tasks: many("tasks") },
  },
);

const tasks = table(
  "tasks",
  {
    id: text().primaryKey(),
    title: text(),
    projectId: text().nullable().references("projects"),
  },
  {
    relations: {
      project: one("projects", "projectId"),
      notes: many("notes"),
    },
  },
);

const notes = table(
  "notes",
  {
    id: text().primaryKey(),
    taskId: text().references("tasks"),
    body: text(),
  },
  { traits: [archivable()] },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [projects, tasks, notes],
});

const gate = await loadPostgresGate();

type Db = ReturnType<typeof connect<typeof app>>;

type TaskPage = {
  readonly items: readonly { readonly id: string; readonly title: string }[];
  readonly next: string | null;
};

function decodeCursor(token: string): unknown {
  const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function catchError(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function withApp(run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

async function ids(
  read: (after: string | null) => PromiseLike<TaskPage>,
): Promise<{ readonly ids: string[]; readonly cursors: string[] }> {
  const seen: string[] = [];
  const cursors: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: TaskPage = await read(after);
    seen.push(...page.items.map((item) => item.id));
    if (page.next === null) return { ids: seen, cursors };
    cursors.push(page.next);
    after = page.next;
  }
  throw new Error("page() did not end");
}

postgresTest(
  gate,
  "a to-one order keeps a missing relation and applies tenant and archive on the join",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.projects.insert([
        { id: "pa", name: "mid", code: "mm" },
        { id: "pm", name: "alpha", code: "aa" },
        { id: "pz", name: "zeta", code: "zz" },
      ]);
      // Same id, a name that would sort first if the join ignored the tenant.
      await b.projects.insert([{ id: "pa", name: "aaa", code: "aa" }]);
      await a.tasks.insert([
        { id: "ta", title: "a", projectId: "pa" },
        { id: "tm", title: "m", projectId: "pm" },
        { id: "tz", title: "z", projectId: "pz" },
        { id: "tn", title: "n", projectId: null },
      ]);

      const order = { project: { name: "asc" as const } };
      const rows = await a.tasks.find({ orderBy: order, limit: 10 });
      expect(rows.map((row) => row.id)).toEqual(["tm", "ta", "tz", "tn"]);
      expect(rows.every((row) => !("~project.name" in row))).toBe(true);
      expect(await a.tasks.one({ orderBy: order })).toMatchObject({ id: "tm" });

      const streamed: string[] = [];
      for await (const row of a.tasks.find({ orderBy: order, limit: 10 }).stream({ batch: 2 })) {
        streamed.push(row.id);
      }
      expect(streamed).toEqual(["tm", "ta", "tz", "tn"]);

      const nullsFirst = await a.tasks.find({
        orderBy: { project: { name: { dir: "asc", nulls: "first" } } },
        limit: 10,
      });
      expect(nullsFirst.map((row) => row.id)).toEqual(["tn", "tm", "ta", "tz"]);

      const planned = await a.tasks.find({ orderBy: order, limit: 5 }).sql();
      expect(planned.text).toContain("left join");
      expect(planned.text.split(" left join ").length - 1).toBe(1);
      expect(planned.text).toContain('o0."tenant_id"');
      expect(planned.text).toContain('o0."archived_at" is null');
      expect(planned.text.includes(TENANT_A)).toBe(false);

      const both = await a.tasks
        .find({ orderBy: { project: { name: "asc", id: "desc" } }, limit: 5 })
        .sql();
      expect(both.text.split(" left join ").length - 1).toBe(1);

      const paged = await ids((after) => a.tasks.page({ orderBy: order, limit: 2, after }));
      expect(paged.ids).toEqual(["tm", "ta", "tz", "tn"]);
      expect(paged.cursors).toHaveLength(1);
      const decoded = decodeCursor(paged.cursors[0] ?? "") as unknown[];
      expect(decoded[0]).not.toBe("k");
      expect(String(decoded[0])).toContain("project.name");
      expect(decoded).toContain("mid");
      expect(JSON.stringify(decoded)).not.toContain("~project.name");

      const acrossNull = await ids((after) =>
        a.tasks.page({
          orderBy: { project: { name: { dir: "asc", nulls: "first" } } },
          limit: 1,
          after,
        }),
      );
      expect(acrossNull.ids).toEqual(["tn", "tm", "ta", "tz"]);
      const nullCursor = decodeCursor(acrossNull.cursors[0] ?? "") as unknown[];
      expect(nullCursor).toContain(null);

      // An archived project sorts as a missing row. It does not drop the task.
      await a.projects.archive({ where: { id: "pz" } });
      const archived = await a.tasks.find({ orderBy: order, limit: 10 });
      expect(archived.map((row) => row.id).slice(0, 2)).toEqual(["tm", "ta"]);
      expect(
        archived
          .map((row) => row.id)
          .slice(2)
          .sort(),
      ).toEqual(["tn", "tz"]);
      const archivedPage = await ids((after) => a.tasks.page({ orderBy: order, limit: 2, after }));
      expect(archivedPage.ids).toEqual(["tm", "ta", "tn", "tz"]);

      const byTitle = await ids((after) =>
        a.tasks.page({ orderBy: { title: "asc" }, limit: 2, after }),
      );
      expect(byTitle.ids).toEqual(["ta", "tm", "tn", "tz"]);
      expect((decodeCursor(byTitle.cursors[0] ?? "") as unknown[])[0]).not.toBe("k");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a hidden related column is refused and a filterable one uses the primary-key cursor",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.projects.insert([
        { id: "pa", name: "alpha", code: "aa" },
        { id: "pm", name: "mid", code: "mm" },
        { id: "pn", name: "nil", code: null },
      ]);
      await a.tasks.insert([
        { id: "t1", title: "a", projectId: "pa" },
        { id: "t2", title: "b", projectId: "pm" },
        { id: "t3", title: "c", projectId: "pn" },
      ]);

      const hidden = await catchError(
        a.tasks.find({ orderBy: { project: { secret: "asc" } } as never, limit: 5 }),
      );
      expect(hidden.code).toBe("OKM1120");
      expect(hidden.message).toContain("hidden");

      const paged = await ids((after) =>
        a.tasks.page({ orderBy: { project: { code: "asc" } }, limit: 2, after }),
      );
      expect(paged.ids).toEqual(["t1", "t2", "t3"]);
      for (const cursor of paged.cursors) {
        const decoded = decodeCursor(cursor) as unknown[];
        expect(decoded[0]).toBe("k");
        expect(String(decoded[1])).toContain("project.code");
        const text = JSON.stringify(decoded);
        expect(text).not.toContain("aa");
        expect(text).not.toContain("mm");
      }

      const distinctOn = await catchError(
        a.tasks.find({
          distinctOn: ["title"],
          orderBy: { title: "asc", project: { name: "asc" } },
          limit: 5,
        }),
      );
      expect(distinctOn.code).toBe("OKM1127");
      expect(distinctOn.message).toContain("distinctOn");

      const distinct = await catchError(
        a.tasks.find({
          distinct: true,
          select: ["title"],
          orderBy: { project: { name: "asc" } },
          limit: 5,
        }),
      );
      expect(distinct.code).toBe("OKM1127");
      expect(distinct.message).toContain("distinct");

      const aggregate = await catchError(
        a.tasks.aggregate({
          count: true,
          orderBy: { project: { name: "asc" } } as never,
        }),
      );
      expect(aggregate.code).toBe("OKM1128");
      expect(aggregate.message).toContain("aggregate");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a to-many count orders numerically and skips archived related rows",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.tasks.insert([
        { id: "t10", title: "ten", projectId: null },
        { id: "t3", title: "three", projectId: null },
        { id: "t1", title: "one", projectId: null },
        { id: "t0", title: "zero", projectId: null },
      ]);
      const bodies: { id: string; taskId: string; body: string }[] = [];
      for (const [taskId, count] of [
        ["t10", 11],
        ["t3", 3],
        ["t1", 1],
      ] as const) {
        for (let index = 0; index < count; index += 1) {
          bodies.push({ id: `${taskId}-${String(index)}`, taskId, body: "n" });
        }
      }
      await a.notes.insert(bodies);
      await a.notes.archive({ where: { id: "t10-0" } });

      const order = { notes: { count: "desc" as const } };
      const rows = await a.tasks.find({ orderBy: order, limit: 10 });
      expect(rows.map((row) => row.id)).toEqual(["t10", "t3", "t1", "t0"]);
      expect(rows.every((row) => !("~notes.count" in row))).toBe(true);

      const planned = await a.tasks.find({ orderBy: order, limit: 5 }).sql();
      expect(planned.text).toContain("left join lateral");
      expect(planned.text).toContain("count(*)::bigint");
      expect(planned.text).toContain('co0."tenant_id"');
      expect(planned.text).toContain('co0."archived_at" is null');
      expect(planned.text.includes("::text")).toBe(false);

      const paged = await ids((after) => a.tasks.page({ orderBy: order, limit: 2, after }));
      expect(paged.ids).toEqual(["t10", "t3", "t1", "t0"]);
      const decoded = decodeCursor(paged.cursors[0] ?? "") as unknown[];
      expect(decoded[0]).not.toBe("k");
      expect(String(decoded[0])).toContain("notes.count");
      expect(decoded).toContain("3");
    });
  },
  60_000,
);
