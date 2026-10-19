/**
 * `versioned()` and `sortable()`: catalog columns, the hash, and the SQL.
 *
 * Writes against Postgres live in `versioned-sortable-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog, ColumnObject, IndexObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { one, schema, table, t } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { via } from "../src/runtime/tenancy/via.js";
import { archivable, sortable, versioned } from "../src/runtime/traits/index.js";
import { explainWrite } from "../src/runtime/write.js";

const plain = table("tasks", {
  id: t.text().primaryKey(),
  title: t.text(),
  laneId: t.text(),
});

const tasks = table(
  "tasks",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    laneId: t.text(),
  },
  { traits: [versioned(), sortable("laneId")] },
);

const bare = schema({ casing: "snake", tables: [plain] });
const app = schema({ casing: "snake", tables: [tasks] });

test("version and position are catalog columns, and the hash changes because of them", () => {
  const version = columnOf(app.catalog, "version");
  const position = columnOf(app.catalog, "position");
  expect(version?.definition).toMatchObject({
    dataType: "integer",
    nullable: false,
    defaultExpression: "1",
  });
  expect(position?.definition).toMatchObject({ dataType: "integer", nullable: false });
  expect(position?.definition.defaultExpression).toBeUndefined();
  expect(version?.provenance).toMatchObject({ origin: "trait", name: "versioned" });
  expect(position?.provenance).toMatchObject({ origin: "trait", name: "sortable" });
  expect(catalogHash(app.catalog)).not.toBe(catalogHash(bare.catalog));

  const index = app.catalog.objects.find(
    (object): object is IndexObject => object.kind === "index" && object.definition.unique === true,
  );
  expect(index?.definition.columns).toEqual(["lane_id", "position"]);
});

test("migrations add version with a default and stop on position without one", () => {
  const added = planMigration({ before: bare.catalog, after: app.catalog, name: "traits" });
  const kinds = added.steps.map((step) => step.kind);
  expect(kinds).toContain("add-column");
  expect(kinds).toContain("add-column-required");
  const versionSql = added.steps.find((step) => step.sql.includes("version"))?.sql ?? "";
  expect(versionSql).toContain("default 1");
  const position = added.steps.find((step) => step.kind === "add-column-required");
  expect(position?.sql).toContain("position");
});

test("the position index names the tenant key and stays partial when archived", () => {
  const tenant = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [
      table(
        "tasks",
        { id: t.text().primaryKey(), title: t.text(), laneId: t.text() },
        { traits: [sortable("laneId"), archivable()] },
      ),
    ],
  });
  const index = tenant.catalog.objects.find(
    (object): object is IndexObject =>
      object.kind === "index" && object.definition.columns.includes("position"),
  );
  expect(index?.definition.columns).toEqual(["tenant_id", "lane_id", "position"]);
  expect(index?.definition.predicate).toBe("(archived_at IS NULL)");
});

test("sortable refuses a path table and a missing group column", () => {
  const path = capture(() =>
    schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
      tables: [
        table("organizations", { id: t.uuid().primaryKey(), name: t.text() }),
        table(
          "tasks",
          {
            id: t.text().primaryKey(),
            title: t.text(),
            organizationId: t.uuid().references("organizations"),
          },
          {
            tenancy: via("organization"),
            relations: { organization: one("organizations", "organizationId") },
            traits: [sortable()],
          },
        ),
      ],
    }),
  );
  expect(path.code).toBe("OKM1060");
  expect(path.message).toContain("via()");

  const missing = capture(() =>
    schema({
      tables: [table("tasks", { id: t.text().primaryKey() }, { traits: [sortable("laneId")] })],
    }),
  );
  expect(missing.code).toBe("OKM1060");
  expect(missing.message).toContain("laneId");
});

test("an update checks the read version and refuses a write that cannot", async () => {
  const planned = await explainWrite(
    app,
    "update",
    "tasks",
    { where: { id: "1" }, set: { title: "b" }, version: 3 },
    {},
    {},
  );
  const text = planned.statements[0]?.text ?? "";
  expect(text).toContain("for update");
  expect(text).toContain("is distinct from");
  expect(text).toContain("+ 1");
  expect(planned.statements).toHaveLength(1);

  const missing = await captureAsync(() =>
    explainWrite(app, "update", "tasks", { where: { id: "1" }, set: { title: "b" } }, {}, {}),
  );
  expect(missing.code).toBe("OKM1120");
  expect(missing.message).toContain("version you read");

  const all = await captureAsync(() =>
    explainWrite(
      app,
      "update",
      "tasks",
      { where: { id: "1" }, set: { title: "b" }, version: 1 },
      {},
      { all: "every row" },
    ),
  );
  expect(all.code).toBe("OKM1120");
  expect(all.message).toContain(".all()");

  const upsert = await captureAsync(() =>
    explainWrite(
      app,
      "insert",
      "tasks",
      { id: "1", title: "a", laneId: "x" },
      { onConflict: { on: "id", update: ["title"] } },
      {},
    ),
  );
  expect(upsert.code).toBe("OKM1120");
  expect(upsert.message).toContain("does not check the version");

  const plainApp = schema({ casing: "snake", tables: [plain] });
  const stray = await captureAsync(() =>
    explainWrite(
      plainApp,
      "update",
      "tasks",
      { where: { id: "1" }, set: { title: "b" }, version: 1 },
      {},
      {},
    ),
  );
  expect(stray.code).toBe("OKM1120");
  expect(stray.message).toContain("versioned()");

  const group = await captureAsync(() =>
    explainWrite(
      app,
      "update",
      "tasks",
      { where: { id: "1" }, set: { laneId: "y" }, version: 1 },
      {},
      {},
    ),
  );
  expect(group.code).toBe("OKM1120");
  expect(group.message).toContain("laneId");
});

test('version: "any" claims with one lock and repeats the predicate', async () => {
  const planned = await explainWrite(
    app,
    "update",
    "tasks",
    {
      where: { id: "1" },
      set: { title: "b" },
      limit: 1,
      lock: "skip",
      version: "any",
    },
    {},
    {},
  );
  const text = planned.statements[0]?.text ?? "";
  expect(text.startsWith('with claimed as (select s."id" as okm_0 from "tasks" as s')).toBe(true);
  expect(text).toContain('order by s."id" limit $2::integer for update of s skip locked');
  expect(text).toContain('update "tasks" as t set ');
  expect(text).toContain('"version" = t."version" + 1');
  expect(text).toContain('from claimed where t."id" = claimed.okm_0 and ');
  expect(occurrences(text, 't."id" = ')).toBe(2);
  expect(occurrences(text, '"id" = $')).toBe(2);
  expect(occurrences(text, "for update")).toBe(1);
  expect(text).not.toContain("stale_free");
  expect(text).toContain('returning t."id"');
  expect(text).toContain('t."version"');

  const numbered = await explainWrite(
    app,
    "update",
    "tasks",
    { where: { id: "1" }, set: { title: "b" }, limit: 1, lock: "skip", version: 1 },
    {},
    {},
  );
  const checked = numbered.statements[0]?.text ?? "";
  expect(occurrences(checked, "for update")).toBe(2);
  expect(checked).toContain("stale_free");

  const bare = await captureAsync(() =>
    explainWrite(
      app,
      "update",
      "tasks",
      { where: { id: "1" }, set: { title: "b" }, version: "any" },
      {},
      {},
    ),
  );
  expect(bare.code).toBe("OKM1120");
  expect(bare.message).toContain('version: "any"');
  expect(bare.fix?.summary).toContain('lock: "skip"');

  const word = await captureAsync(() =>
    explainWrite(
      app,
      "update",
      "tasks",
      { where: { id: "1" }, set: { title: "b" }, version: "latest" },
      {},
      {},
    ),
  );
  expect(word.code).toBe("OKM1120");
  expect(word.message).toContain("latest");
  expect(word.fix?.summary.length).toBeGreaterThan(0);

  const assigned = await captureAsync(() =>
    explainWrite(
      app,
      "update",
      "tasks",
      { where: { id: "1" }, set: { title: "b", version: 2 }, version: 1 },
      {},
      {},
    ),
  );
  expect(assigned.code).toBe("OKM1120");
  expect(assigned.message).toContain("cannot set version");
  expect(assigned.fix?.summary).toContain("bumps");
});

function occurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

test("an insert locks before it reads the group's max position", async () => {
  const planned = await explainWrite(
    app,
    "insert",
    "tasks",
    [
      { id: "1", title: "a", laneId: "b" },
      { id: "2", title: "c", laneId: "a" },
    ],
    {},
    {},
  );
  expect(planned.statements).toHaveLength(2);
  const lock = planned.statements[0];
  const insert = planned.statements[1];
  expect(lock?.text ?? "").toContain("pg_advisory_xact_lock");
  expect(lock?.text ?? "").toContain("order by v.okm_lock");
  expect(lock?.text ?? "").not.toContain("insert into");
  const locked = [...(lock?.params ?? [])].map((value) => String(value));
  expect(locked).toHaveLength(2);
  expect(locked).toEqual(
    [...locked].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  expect(insert?.text ?? "").not.toContain("pg_advisory_xact_lock");
  expect(insert?.text ?? "").toContain("coalesce(max(");
  expect(insert?.text ?? "").toContain('("id", "title", "lane_id", "position")');
  expect(insert?.text ?? "").toContain('returning "id", "title", "lane_id", "version", "position"');

  const omitted = await captureAsync(() =>
    explainWrite(app, "insert", "tasks", { id: "1", title: "a" }, {}, {}),
  );
  expect(omitted.code).toBe("OKM1121");
  expect(omitted.message).toContain("laneId");
});

function columnOf(source: Catalog, field: string): ColumnObject | undefined {
  return source.objects.find(
    (object): object is ColumnObject => object.kind === "column" && object.identity.name === field,
  );
}

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function captureAsync(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
