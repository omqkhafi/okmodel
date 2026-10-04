/**
 * Column tenancy: catalog objects, scope SQL, and the refusals.
 *
 * Rows on real Postgres are `tenancy-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  every,
  has,
  id,
  index,
  none,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { app, ORG, TASK, TENANT_A, TENANT_B } from "./tenancy-schema.js";

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

test("catalog stores the tenant column, composite keys, and widened uniques", () => {
  const objects = app.catalog.objects;
  const column = objects.find(
    (object) =>
      object.kind === "column" &&
      object.identity.parent.name === "tasks" &&
      object.identity.name === "tenant_id",
  );
  expect(column?.kind === "column" ? column.definition.nullable : true).toBe(false);
  expect(
    objects.some(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "countries" &&
        object.identity.name === "tenant_id",
    ),
  ).toBe(false);

  const pk = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.identity.parent.name === "tasks" &&
      object.definition.constraintKind === "primaryKey",
  );
  expect(pk?.kind === "constraint" ? pk.definition.columns : []).toEqual(["id", "tenant_id"]);

  const tenantUnique = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === "tasks" &&
      object.definition.columns.join(",") === "id,tenant_id",
  );
  expect(tenantUnique).toBeDefined();

  const title = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.definition.nameKey === "title",
  );
  expect(title?.kind === "constraint" ? title.definition.columns : []).toEqual([
    "tenant_id",
    "title",
  ]);

  const code = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.definition.nameKey === "code",
  );
  expect(code?.kind === "constraint" ? code.definition.columns : []).toEqual(["code"]);

  const fk = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.identity.parent.name === "tasks",
  );
  expect(fk?.kind === "constraint" ? fk.definition.columns : []).toEqual(["org_id", "tenant_id"]);
  expect(fk?.kind === "constraint" ? fk.definition.references?.columns : []).toEqual([
    "id",
    "tenant_id",
  ]);

  const listed = objects.find(
    (object) => object.kind === "index" && object.identity.parent.name === "tasks",
  );
  expect(listed?.kind === "index" ? listed.definition.columns : []).toEqual(["tenant_id", "title"]);

  const sql = renderCatalog(app.catalog, "public").join("\n");
  expect(sql).toContain("tenant_id");
  expect(sql).toContain('foreign key ("org_id", "tenant_id")');
  expect(sql).toContain('unique ("tenant_id", "title")');
  expect(sql).toContain('primary key ("id", "tenant_id")');
});

test("a schema without tenancy does not grow a tenant column", () => {
  const notes = table("notes", { id: id({ default: "none" }), title: text() });
  const plain = schema({ casing: "snake", tables: [notes] });
  expect(
    plain.catalog.objects.some(
      (object) => object.kind === "column" && object.identity.name === "tenant_id",
    ),
  ).toBe(false);
});

test("scope SQL filters every read, and the tenant value is not the cache key", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  const left = a.tasks.find({ where: { title: "ship" }, limit: 1 }).sql();
  const right = b.tasks.find({ where: { title: "ship" }, limit: 1 }).sql();
  if (left instanceof Promise || right instanceof Promise) {
    throw new Error("a read without include plans synchronously");
  }
  expect(left.text).toBe(right.text);
  expect(left.text).toContain('"tenant_id" = ');
  expect(left.params[0]).toBe(TENANT_A);
  expect(right.params[0]).toBe(TENANT_B);
  expect(left.text.includes(TENANT_A)).toBe(false);

  const viewed = a.tasks.find({ where: { title: "ship" }, limit: 1 }).inspect();
  const other = b.tasks.find({ where: { title: "ship" }, limit: 1 }).inspect();
  if (viewed instanceof Promise || other instanceof Promise) {
    throw new Error("inspect planned asynchronously");
  }
  expect(viewed.plan.fingerprint).toBe(other.plan.fingerprint);
  expect(viewed.rules.some((rule) => rule.contribution === "scoped")).toBe(true);

  const counted = a.tasks.count({ where: { title: "ship" } }).sql();
  if (counted instanceof Promise) throw new Error("count planned asynchronously");
  expect(counted.text.startsWith("select count(*)")).toBe(true);
  expect(counted.text).toContain('"tenant_id" = ');
  expect(counted.params[0]).toBe(TENANT_A);

  const present = a.tasks.exists({ where: { id: TASK } }).sql();
  if (present instanceof Promise) throw new Error("exists planned asynchronously");
  expect(present.text).toContain('"tenant_id" = ');

  const matched = await promised(
    a.orgs.find({ where: { tasks: has({ title: "ship" }) }, limit: 5 }).sql(),
  );
  expect(matched.text).toContain("exists (select 1 from");
  expect(matched.text.match(/"tenant_id" = /g)?.length).toBeGreaterThan(1);

  const absent = await promised(
    a.orgs.find({ where: { tasks: none({ title: "secret" }) }, limit: 5 }).sql(),
  );
  expect(absent.text).toContain("not exists");
  expect(absent.text).toContain('"tenant_id" = ');

  const allShip = await promised(
    a.orgs.find({ where: { tasks: every({ title: "ship" }) }, limit: 5 }).sql(),
  );
  expect(allShip.text).toContain("not exists");
  expect(allShip.text).toContain('"tenant_id" = ');

  const included = await a.tasks
    .find({ where: { id: TASK }, limit: 1, include: { org: true } })
    .sql();
  expect(included.text).toContain('"tenant_id" = ');
  expect(included.params[0]).toBe(TENANT_A);

  const nested = await a.orgs
    .find({ where: { id: ORG }, limit: 1, include: { tasks: { limit: 5 } } })
    .sql();
  expect(nested.text).toContain('"tenant_id" = ');

  const open = db.unscoped("nightly report");
  const report = open.tasks.find({ limit: 5 }).sql();
  if (report instanceof Promise) throw new Error("unscoped find planned asynchronously");
  expect(report.text.includes('"tenant_id" = ')).toBe(false);
  const lines = open.tasks.find({ limit: 5 }).inspect();
  if (lines instanceof Promise) throw new Error("unscoped inspect planned asynchronously");
  expect(lines.rules.some((rule) => rule.contribution === "unscoped nightly report")).toBe(true);

  const shared = db.countries.find({ limit: 5 }).sql();
  if (shared instanceof Promise) throw new Error("global find planned asynchronously");
  expect(shared.text.includes('"tenant_id"')).toBe(false);
  const sharedView = db.countries.find({ limit: 5 }).inspect();
  if (sharedView instanceof Promise) throw new Error("global inspect planned asynchronously");
  expect(
    sharedView.rules.some((rule) => rule.contribution.includes("global shared reference data")),
  ).toBe(true);
  const taskView = a.tasks.find({ where: { code: "x" }, limit: 1 }).inspect();
  if (taskView instanceof Promise) throw new Error("unique inspect planned asynchronously");
  expect(
    taskView.rules.some((rule) => rule.contribution.includes("unique code global shared codes")),
  ).toBe(true);

  await db.close();
});

test("writes stamp the scope and refuse the tenant key", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const a = db.for({ tenantId: TENANT_A });
  const inserted = await a.tasks.insert({ id: TASK, title: "ship", code: "one", orgId: ORG }).sql();
  expect(inserted.statements[0]?.text).toContain('"tenant_id"');
  expect(inserted.statements[0]?.params).toContain(TENANT_A);
  expect(inserted.statements[0]?.text.includes(TENANT_A)).toBe(false);

  const batch = await a.orgs
    .insert([
      { id: ORG, name: "Acme" },
      { id: TASK, name: "Beta" },
    ])
    .sql();
  expect(batch.statements.length).toBeGreaterThan(0);
  for (const statement of batch.statements) {
    expect(statement.text).toContain('"tenant_id"');
    expect(statement.params).toContain(TENANT_A);
  }

  const updated = await a.tasks.update({ where: { id: TASK }, set: { title: "next" } }).sql();
  expect(updated.statements[0]?.text).toContain('"tenant_id" = ');
  expect(updated.statements[0]?.params).toContain(TENANT_A);

  const listed = await a.tasks.update([{ where: { id: TASK }, set: { title: "listed" } }]).sql();
  expect(listed.statements[0]?.text).toContain('"tenant_id" = ');

  const removed = await a.tasks.delete({ where: { id: TASK } }).sql();
  expect(removed.statements[0]?.text).toContain('"tenant_id" = ');
  expect(removed.statements[0]?.text.startsWith("delete from")).toBe(true);

  const open = db.unscoped("nightly report");
  const cleared = await open.tasks.delete({ where: { id: TASK } }).sql();
  expect(cleared.statements[0]?.text.includes('"tenant_id"')).toBe(false);
  await expectCode(
    open.tasks.insert({ id: TASK, title: "x", code: "y", orgId: ORG }).sql(),
    "OKM1701",
  );

  await expectCode(
    a.tasks
      .insert({ id: TASK, title: "x", code: "y", orgId: ORG, tenantId: TENANT_B } as never)
      .sql(),
    "OKM1190",
  );
  await expectCode(
    a.tasks
      .insert({ id: TASK, title: "x", code: "y", orgId: ORG, tenantId: TENANT_B } as never, {
        allow: ["tenantId"],
      })
      .sql(),
    "OKM1190",
  );
  await expectCode(
    () => a.tasks.find({ where: { tenantId: TENANT_A } as never, limit: 1 }).sql(),
    "OKM1704",
  );
  await expectCode(
    a.tasks.update({ where: { id: TASK }, set: { tenantId: TENANT_B } } as never).sql(),
    "OKM1704",
  );

  const root = db as unknown as { table(name: string): unknown; for(input: object): unknown };
  expect(() => root.table("tasks")).toThrow(OkmError);
  try {
    root.table("tasks");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1701");
  }
  expect(() => root.for({ tenantId: TENANT_A, extra: "no" })).toThrow(OkmError);
  expect(() => db.for({ tenantId: "not-a-uuid" })).toThrow(OkmError);
  expect(() => db.unscoped("")).toThrow(OkmError);
  expect(() => db.unscoped("   ")).toThrow(OkmError);

  await db.close();
});

test("tenancy definition errors name the column, the index, and the reference", () => {
  const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });
  expect(() =>
    schema({
      tenancy,
      tables: [
        table(
          "wide",
          { id: id({ default: "none" }), title: text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    }),
  ).toThrow(OkmError);
  try {
    schema({
      tenancy,
      tables: [
        table(
          "wide",
          { id: id({ default: "none" }), title: text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1706");
  }

  const tasks = table("tasks", { id: id({ default: "none" }), title: text() });
  const audit = table(
    "audit",
    { id: id({ default: "none" }), taskId: uuid().references("tasks") },
    { tenancy: global("audit log") },
  );
  expect(() => schema({ tenancy, tables: [tasks, audit] })).toThrow(OkmError);
  try {
    schema({ tenancy, tables: [tasks, audit] });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1705");
  }

  expect(() =>
    schema({
      tenancy,
      tables: [
        table("orgs", { id: id({ default: "none" }) }),
        table("tasks", {
          id: id({ default: "none" }),
          orgId: uuid().nullable().references("orgs", { onDelete: "set null" }),
        }),
      ],
    }),
  ).toThrow(/set null/);

  expect(() =>
    schema({
      tenancy,
      tables: [
        table("orgs", { id: id({ default: "none" }) }),
        table("tasks", {
          id: id({ default: "none" }),
          orgId: uuid().references("orgs", { onUpdate: "set default" }),
        }),
      ],
    }),
  ).toThrow(/set default/);

  expect(() => text().unique({ global: "" })).toThrow(/reason/);
  expect(() => text().unique({ global: true })).not.toThrow();
  expect(() =>
    schema({
      tenancy,
      tables: [
        table("tasks", { id: id({ default: "none" }), code: text().unique({ global: true }) }),
      ],
    }),
  ).toThrow(/reason/);

  const shared = table(
    "countries",
    { id: id({ default: "none" }) },
    { tenancy: global("shared reference data") },
  );
  expect(() => schema({ tables: [shared] })).toThrow(/does not/);
  expect(() =>
    schema({
      tenancy,
      tables: [table("child", { id: id({ default: "none" }) }, { tenancy: { via: "parent.org" } })],
    }),
  ).toThrow(OkmError);

  expect(() => global("")).toThrow(/reason/);
  expect(() =>
    schema({
      tenancy,
      tables: [table("tasks", { id: id({ default: "none" }), tenantId: uuid() })],
    }),
  ).toThrow(OkmError);
});

test("relations resolve the composite foreign key", () => {
  const task = app.model.tasks?.relations.find((relation) => relation.name === "org");
  const org = app.model.orgs?.relations.find((relation) => relation.name === "tasks");
  expect(task).toEqual({
    name: "org",
    kind: "one",
    table: "orgs",
    local: ["org_id", "tenant_id"],
    remote: ["id", "tenant_id"],
  });
  expect(org).toEqual({
    name: "tasks",
    kind: "many",
    table: "tasks",
    local: ["id", "tenant_id"],
    remote: ["org_id", "tenant_id"],
  });
});

function promised<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

async function expectCode(
  pending: Promise<unknown> | (() => unknown),
  code: string,
): Promise<void> {
  try {
    await (typeof pending === "function" ? pending() : pending);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
