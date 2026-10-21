/**
 * Literal proofs for the Postgres feature registry.
 *
 * Each `proof:` title is the `proof` of one registry entry. A title that
 * already exists in another file is not repeated here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { openPreparedPglite } from "../packages/harness/src/pglite-template.js";
import type { DriverConnection, DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import {
  arr,
  fragment,
  gte,
  json,
  many,
  one,
  rowNumber,
  schema,
  sql,
  t,
  table,
} from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { refreshView } from "../src/dialects/pg/view/refresh.js";
import { createClient } from "../src/runtime/client.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { archivable } from "../src/runtime/traits/index.js";
import { featuresUsed } from "../src/tooling/capabilities/used.js";
import { describe } from "../src/tooling/migrate/index.js";
import { placeCatalog } from "../src/tooling/migrate/place.js";
import { retargetSteps } from "../src/tooling/migrate/sandbox.js";

const EMPTY: ExecuteResult = { rows: [], count: 0, notices: [] };
const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function stub(): DriverPool {
  let checked = false;
  return {
    capabilities: { transactions: "interactive", stream: false, listen: false, cancel: false },
    execute() {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(EMPTY);
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function interactive(): { readonly pool: DriverPool; readonly texts: string[] } {
  const texts: string[] = [];
  let checked = false;
  const connection: DriverConnection = {
    execute(text) {
      texts.push(text);
      return Promise.resolve(EMPTY);
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  };
  const pool: DriverPool = {
    capabilities: { transactions: "interactive", stream: true, listen: true, cancel: true },
    execute() {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(EMPTY);
    },
    reserve: () => Promise.resolve(connection),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  return { pool, texts };
}

const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
const notesSchema = schema({ casing: "snake", tables: [notes] });

test("proof:schema.core", () => {
  const users = table(
    "users",
    { id: t.uuid().primaryKey(), email: t.text().unique(), position: t.integer() },
    { checks: { positionPositive: (columns) => sql`${columns.position} >= 0` } },
  );
  const posts = table("posts", {
    id: t.uuid().primaryKey(),
    userId: t.uuid().references("users"),
  });
  const built = schema({ tables: [users, posts] });
  const kinds = built.catalog.objects
    .filter((object) => object.kind === "constraint")
    .map((object) => object.definition.constraintKind);
  expect(kinds).toContain("primaryKey");
  expect(kinds).toContain("unique");
  expect(kinds).toContain("foreignKey");
  expect(kinds).toContain("check");
  expect(featuresUsed(built.catalog)).toContain("schema.core");
});

test("proof:schema.identity", () => {
  const built = schema({ tables: [table("users", { id: t.identity() })] });
  const column = built.catalog.objects.find(
    (object) => object.kind === "column" && object.identity.name === "id",
  );
  if (column?.kind !== "column") throw new Error("expected an id column");
  expect(column.definition.identity).toEqual({ always: true });
  expect(featuresUsed(built.catalog)).toContain("schema.identity");
});

test("proof:type.uuid", () => {
  const built = schema({ tables: [table("users", { id: t.uuid() })] });
  const column = built.catalog.objects.find((object) => object.kind === "column");
  if (column?.kind !== "column") throw new Error("expected a column");
  expect(column.definition.dataType).toBe("uuid");
  expect(featuresUsed(built.catalog)).toContain("type.uuid");
});

test("proof:type.uuidv7", () => {
  const built = schema({
    tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })],
  });
  const description = describe(built);
  expect(description.minPostgres).toBe(18);
  expect(description.requirements.minVersion.postgres).toBe(18);
  expect(description.requirements.features).toContain("type.uuidv7");
  expect(description.requirements.emulated).toEqual([]);
  const column = built.catalog.objects.find(
    (object) => object.kind === "column" && object.identity.name === "id",
  );
  if (column?.kind !== "column") throw new Error("expected an id column");
  expect(column.definition.defaultExpression).toBe("uuidv7()");
  expect(() =>
    schema({
      minPostgres: 17,
      tables: [table("users", { id: t.id({ default: "uuidv7" }) })],
    }),
  ).toThrow(OkmError);
});

test("proof:type.jsonb", () => {
  const built = schema({ tables: [table("docs", { meta: t.jsonb() })] });
  expect(featuresUsed(built.catalog)).toContain("type.jsonb");
});

test("proof:type.array", () => {
  const built = schema({ tables: [table("docs", { tags: t.text().array() })] });
  const column = built.catalog.objects.find((object) => object.kind === "column");
  if (column?.kind !== "column") throw new Error("expected a column");
  expect(column.definition.dataType).toBe("text[]");
  expect(featuresUsed(built.catalog)).toContain("type.array");
});

test("proof:type.range", () => {
  const built = schema({ tables: [table("spans", { during: t.int4range() })] });
  const column = built.catalog.objects.find((object) => object.kind === "column");
  if (column?.kind !== "column") throw new Error("expected a column");
  expect(column.definition.dataType).toBe("int4range");
  expect(featuresUsed(built.catalog)).toContain("type.range");
});

test("proof:type.enum", () => {
  const built = schema({
    tables: [table("items", { status: t.enum("color", ["red", "blue"]) })],
  });
  expect(featuresUsed(built.catalog)).toContain("type.enum");
});

test("proof:type.domain", () => {
  const built = schema({
    tables: [table("people", { email: t.domain("email_d", t.text(), "length(value) > 0") })],
  });
  expect(featuresUsed(built.catalog)).toContain("type.domain");
});

test("proof:index.partial", () => {
  const lists = table("lists", { id: t.id(), name: t.text().unique() }, { traits: [archivable()] });
  const built = schema({ tables: [lists] });
  const partial = built.catalog.objects.some(
    (object) =>
      object.kind === "index" &&
      object.definition.predicate !== undefined &&
      object.definition.predicate.includes("IS NULL"),
  );
  expect(partial).toBe(true);
  expect(featuresUsed(built.catalog)).toContain("index.partial");
});

test("proof:index.expression", () => {
  const trgm = pgTrgm();
  const built = schema({
    tables: [
      table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] }),
    ],
    extensions: [trgm],
  });
  const index = built.catalog.objects.find((object) => object.kind === "index");
  if (index?.kind !== "index") throw new Error("expected an index");
  expect(index.definition.expression).toContain("gin_trgm_ops");
  expect(featuresUsed(built.catalog)).toContain("index.expression");
});

test("proof:column.generated", () => {
  const built = schema({
    tables: [table("stats", { total: t.integer().generated("1") })],
  });
  const column = built.catalog.objects.find((object) => object.kind === "column");
  if (column?.kind !== "column") throw new Error("expected a column");
  expect(column.definition.generated?.expression).toBe("1");
  expect(featuresUsed(built.catalog)).toContain("column.generated");
});

test("proof:namespace", () => {
  const built = schema({ tables: [table("users", { id: t.id() })] });
  const placed = placeCatalog(built.catalog, "app", new Map());
  expect(featuresUsed(placed)).toContain("namespace");
  expect(featuresUsed(built.catalog)).not.toContain("namespace");
});

test("proof:extension", () => {
  const built = schema({
    tables: [table("users", { id: t.id() })],
    extensions: [extension("vector")],
  });
  const description = describe(built);
  expect(description.extensions).toEqual([{ name: "vector", reason: "extension(vector)" }]);
  expect(description.requirements.extensions).toEqual(description.extensions);
  expect(description.requirements.features).toContain("extension");
});

test("proof:query.relational", () => {
  const users = table("users", { id: t.id() }, { relations: { notes: many("notes") } });
  const notes = table(
    "notes",
    { id: t.id(), userId: t.uuid().references("users") },
    { relations: { user: one("users") } },
  );
  const built = schema({ tables: [users, notes] });
  expect(
    built.catalog.objects.some(
      (object) => object.kind === "constraint" && object.definition.constraintKind === "foreignKey",
    ),
  ).toBe(true);
});

test("proof:query.keyset", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes.page({ orderBy: { id: "asc" }, limit: 2 }).sql();
  expect(described.text.toLowerCase()).not.toContain(" offset ");
  expect(described.text).toContain('"id"');
});

test("proof:query.window", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes
    .find({
      select: ["id", rowNumber({ orderBy: { id: "asc" }, as: "n" })],
      limit: 2,
    })
    .sql();
  expect(described.text).toContain("row_number()");
});

test("proof:query.countDistinct", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes.aggregate({ countDistinct: ["body"], limit: 1 }).sql();
  expect(described.text).toContain("count(distinct ");
});

test("proof:query.distinct", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes.find({ distinct: true, select: ["body"], limit: 2 }).sql();
  expect(described.text).toContain("select distinct ");
});

test("proof:query.distinctOn", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes
    .find({ distinctOn: ["body"], orderBy: { body: "asc" }, limit: 2 })
    .sql();
  expect(described.text).toContain("select distinct on (");
});

test("proof:query.namedAggregates", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes
    .aggregate({ select: { total: { countDistinct: "body" } }, limit: 1 })
    .sql();
  expect(described.text).toContain("count(distinct ");
});

test("proof:query.having", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes
    .aggregate({ groupBy: ["body"], having: { count: gte(2) }, limit: 2 })
    .sql();
  expect(described.text).toContain(" having count(*) >= ");
});

test("proof:query.orderNulls", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const found = await db.notes
    .find({ orderBy: { body: { dir: "asc", nulls: "first" } }, limit: 2 })
    .sql();
  expect(found.text).toContain('"body" asc nulls first');
  const grouped = await db.notes
    .aggregate({
      groupBy: ["body"],
      orderBy: { count: { dir: "desc", nulls: "last" } },
      limit: 2,
    })
    .sql();
  expect(grouped.text).toContain("order by count(*) desc nulls last");
});

test("proof:query.upsert", async () => {
  const db = await connect(stub(), { schema: notesSchema });
  const described = await db.notes.insert({ id: "a", body: "x" }, { onConflict: "ignore" }).sql();
  expect(described.statements[0]?.text.toLowerCase()).toContain("on conflict");
});

test("proof:bulk.insert", async () => {
  const users = table("users", { id: t.uuid(), email: t.text() });
  const built = schema({ tables: [users] });
  const db = await connect(stub(), { schema: built });
  const described = await db.users
    .insert([
      { id: ID, email: "a@b.c" },
      { id: ID2, email: "b@b.c" },
    ])
    .sql();
  const text = described.statements[0]?.text ?? "";
  expect(text.toLowerCase()).toContain("values");
  expect(described.statements[0]?.params).toContain("a@b.c");
  expect(described.statements[0]?.params).toContain("b@b.c");
});

test("proof:atomic.json", async () => {
  const docs = table("docs", { id: t.text().primaryKey(), meta: t.jsonb() });
  const built = schema({ casing: "snake", tables: [docs] });
  const db = await connect(stub(), { schema: built });
  const described = await db.docs
    .update({ where: { id: "a" }, set: { meta: json.set(["published"], false) } })
    .sql();
  expect(described.statements[0]?.text).toContain("jsonb_set(");
});

test("proof:atomic.array", async () => {
  const docs = table("docs", { id: t.text().primaryKey(), tags: t.text().array() });
  const built = schema({ casing: "snake", tables: [docs] });
  const db = await connect(stub(), { schema: built });
  const described = await db.docs
    .update({ where: { id: "a" }, set: { tags: arr.append("late") } })
    .sql();
  expect(described.statements[0]?.text).toContain("array_append(");
});

test("proof:tx.savepoints", async () => {
  const { pool, texts } = interactive();
  const db = createClient(notesSchema, pool, { ownsPool: false });
  await db.tx(async (outer) => {
    await outer.tx(async () => 1);
  });
  expect(texts.some((text) => text.startsWith("SAVEPOINT "))).toBe(true);
  expect(texts.some((text) => text.startsWith("RELEASE SAVEPOINT "))).toBe(true);
});

test("proof:tx.isolation", async () => {
  const { pool, texts } = interactive();
  const db = createClient(notesSchema, pool, { ownsPool: false });
  await db.tx({ isolation: "serializable" }, async () => 1);
  expect(texts[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
});

test("proof:tx.retry", async () => {
  const { pool, texts } = interactive();
  const db = createClient(notesSchema, pool, { ownsPool: false });
  let attempts = 0;
  await db.tx({ retry: 1 }, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new OkmError("serialization", "could not serialize access", { kind: "serialization" });
    }
    return 1;
  });
  expect(attempts).toBe(2);
  expect(texts.filter((text) => text.startsWith("BEGIN"))).toHaveLength(2);
});

test("proof:lock.advisory", async () => {
  const { pool, texts } = interactive();
  const db = createClient(notesSchema, pool, { ownsPool: false });
  await db.tx(async (outer) => {
    await outer.advisoryLock("orders");
  });
  expect(texts.some((text) => text.includes("pg_advisory_xact_lock"))).toBe(true);
});

test("proof:listen.notify", async () => {
  const pool = await openPreparedPglite([]);
  try {
    const payloads: string[] = [];
    if (pool.listen === undefined) throw new Error("pglite listen is missing");
    const stop = await pool.listen("okm_f1", (payload) => {
      payloads.push(payload);
    });
    try {
      await pool.execute("select pg_notify('okm_f1', 'ping')");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(payloads).toContain("ping");
    } finally {
      await stop();
    }
  } finally {
    await pool.close();
  }
});

test("proof:session.settings", async () => {
  const texts: string[] = [];
  const connection: DriverConnection = {
    execute(text) {
      texts.push(text);
      return Promise.resolve(EMPTY);
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  };
  const pool: DriverPool = {
    capabilities: { transactions: "interactive", stream: false, listen: false, cancel: true },
    execute: () => Promise.resolve(EMPTY),
    reserve: () => Promise.resolve(connection),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  await refreshView({ pool, connected: Promise.resolve() }, "docs", false);
  expect(texts).toContain("select set_config('app.unscoped', 'on', true)");
});

test("proof:roles.grants", () => {
  const built = schema({ tables: [table("users", { id: t.id() })] });
  const withRoles = attachRoles(built.catalog, { migration: "okm_migrate", app: "okm_app" });
  expect(withRoles.objects.some((object) => object.kind === "role")).toBe(true);
  expect(withRoles.objects.some((object) => object.kind === "grant")).toBe(true);
  expect(featuresUsed(withRoles)).toContain("roles.grants");
});

test("proof:guard.fragment", () => {
  let code = "";
  try {
    const built = fragment`true; drop table notes`;
    expect(built).toBeDefined();
  } catch (error) {
    if (error instanceof OkmError) code = error.code;
  }
  expect(code).toBe("OKM1125");
});

test("proof:tooling.scratchReplay", () => {
  const source = readFileSync(join(repoRoot(), "src/tooling/migrate/sandbox.ts"), "utf8");
  const start = source.indexOf("async function inCheckTransaction");
  const body = source.slice(start, source.indexOf("\nasync function ", start + 10));
  expect(body).toContain('unsafe("begin")');
  expect(body).toContain('unsafe("rollback")');
  expect(body).toContain("create schema");
  const moved = retargetSteps(
    [
      {
        sql: 'create table "public"."people" ("id" uuid)',
        class: "expand",
        action: "ddl",
        lock: "AccessShareLock",
        transactional: true,
      },
    ],
    "okm_check_abc",
  );
  expect(moved[0]?.sql).toContain('"okm_check_abc"."people"');
});

test("proof:tooling.describe", () => {
  const built = schema({
    minPostgres: 17,
    tables: [table("users", { id: t.id(), name: t.text() })],
  });
  const description = describe(built);
  expect(description.logical).toEqual({ format: 1, name: "public", namespace: "public" });
  expect(description.requirements.minVersion.postgres).toBe(description.minPostgres);
  expect(description.requirements.minVersion.postgres).toBe(17);
  const again = describe(description);
  expect(again.requirements.features).toEqual(description.requirements.features);
  expect(again.requirements.minVersion).toEqual(description.requirements.minVersion);
});
