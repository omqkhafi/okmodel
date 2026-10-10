/**
 * `db.views` is typed from `schema({ views })`.
 *
 * Connected, scoped, and routed clients carry it. A schema without views has
 * no `views` member. Every view field is text or null.
 */

import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tasks],
  views: [
    view("active_tasks", {
      columns: [
        { name: "tenant_id", type: "uuid" },
        { name: "open_count", type: "bigint" },
      ],
      query: "select tenant_id, count(*) as open_count from tasks group by tenant_id",
    }),
    materializedView("task_titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from tasks",
    }),
  ],
});
const plain = schema({ tables: [tasks] });

type Has<T, K extends string> = K extends keyof T ? true : false;
type Active = { readonly tenantId: string | null; readonly openCount: string | null };

void (async () => {
  const db = await connect("memory://views", { schema: app });
  const scoped = db.for({ tenantId: "00000000-0000-0000-0000-000000000000" });
  expectTypeOf<Has<typeof scoped, "views">>().toEqualTypeOf<true>();
  expectTypeOf<Has<typeof scoped.views, "activeTasks" | "taskTitles">>().toEqualTypeOf<true>();

  const rows = await scoped.views.activeTasks.find({ limit: 5, orderBy: { openCount: "desc" } });
  expectTypeOf(rows).toEqualTypeOf<readonly Active[]>();

  const picked = await scoped.views.activeTasks.find({ limit: 5, select: ["openCount"] });
  expectTypeOf(picked).toEqualTypeOf<readonly { readonly openCount: string | null }[]>();

  const all = await db.views.taskTitles.find({}).all("every title");
  expectTypeOf(all).toEqualTypeOf<readonly { readonly title: string | null }[]>();

  expectTypeOf(await scoped.views.activeTasks.one()).toEqualTypeOf<Active | null>();
  expectTypeOf(await scoped.views.activeTasks.count()).toEqualTypeOf<number>();
  expectTypeOf(
    await scoped.views.activeTasks.exists({ where: { openCount: "0" } }),
  ).toEqualTypeOf<boolean>();

  expectTypeOf(db.views.taskTitles.refresh()).toEqualTypeOf<Promise<void>>();
  // @ts-expect-error a plain view has no refresh()
  void scoped.views.activeTasks.refresh;

  // @ts-expect-error a view field that was not declared
  void scoped.views.activeTasks.find({ limit: 1, where: { title: "x" } });
  // @ts-expect-error a view that was not declared
  void scoped.views.closedTasks;
  // @ts-expect-error views are read-only
  void scoped.views.activeTasks.insert;

  const bare = await connect("memory://plain", { schema: plain });
  expectTypeOf<Has<typeof bare, "views">>().toEqualTypeOf<false>();

  const routed = await connect(
    { primary: "memory://p", replicas: ["memory://r"] },
    { schema: app },
  );
  expectTypeOf<Has<ReturnType<typeof routed.using>, "views">>().toEqualTypeOf<true>();
});
