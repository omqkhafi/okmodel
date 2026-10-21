/**
 * Profile that refuses every Postgres feature, and the portable minimum.
 *
 * The profile lives in the harness. `src/` does not import it.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  openClosedDriver,
  closedRegistry,
  CLOSED_CAPABILITIES,
} from "../packages/harness/src/closed-profile.js";
import { collectConformanceMarks } from "../packages/harness/src/conformance-collect.js";
import {
  formatConformanceCounts,
  portable,
  type SuiteTest,
} from "../packages/harness/src/driver-suite.js";
import { repoRoot } from "../scripts/root.js";
import { DriverError } from "../src/adapters/error.js";
import { CAPABILITY_NAMES } from "../src/adapters/capabilities.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import type { DdlDialect } from "../src/dialects/ddl.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { createClient } from "../src/runtime/client.js";
import { archivable } from "../src/runtime/traits/index.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";
import {
  assertSupported,
  collectTestTitles,
  registryProblems,
} from "../src/tooling/capabilities/index.js";
import { featuresUsed } from "../src/tooling/capabilities/used.js";
import { placeCatalog } from "../src/tooling/migrate/place.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const closed = closedRegistry();

function refuse(key: string): void {
  const entry = closed[key];
  expect(entry?.support).toBe("refused");
  expect(entry?.code).toBe("OKM1860");
  expect(entry?.alternative).toBe(`Portable substitute for ${key}.`);
  let caught: unknown;
  try {
    assertSupported([key], closed, "closed");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  if (!(caught instanceof OkmError) || entry === undefined) return;
  const code = entry.code;
  const alternative = entry.alternative;
  if (code === undefined || alternative === undefined) {
    throw new Error(`${key} is refused without a code and an alternative.`);
  }
  expect(caught.code).toBe(code);
  expect(caught.message).toContain(`closed refuses ${key}.`);
  expect(caught.fix.summary).toContain(alternative);
}

function catalogs(): readonly Catalog[] {
  const users = table("users", { id: t.uuid().primaryKey(), email: t.text() });
  const identity = schema({ tables: [table("people", { id: t.identity() })] }).catalog;
  const uuid = schema({ tables: [table("users", { id: t.uuid() })] }).catalog;
  const uuidv7 = schema({
    tables: [table("users", { id: t.id({ default: "uuidv7" }) })],
  }).catalog;
  const jsonb = schema({ tables: [table("docs", { meta: t.jsonb() })] }).catalog;
  const arrays = schema({ tables: [table("docs", { tags: t.text().array() })] }).catalog;
  const range = schema({ tables: [table("spans", { during: t.int4range() })] }).catalog;
  const enumerated = schema({
    tables: [table("items", { status: t.enum("color", ["red", "blue"]) })],
  }).catalog;
  const domain = schema({
    tables: [table("people", { email: t.domain("email_d", t.text(), "length(value) > 0") })],
  }).catalog;
  const partial = schema({
    tables: [table("lists", { id: t.id(), name: t.text().unique() }, { traits: [archivable()] })],
  }).catalog;
  const expression = schema({
    tables: [
      table(
        "docs",
        { id: t.id(), body: t.text() },
        { indexes: (c) => [pgTrgm().gin(c.body.name)] },
      ),
    ],
    extensions: [pgTrgm()],
  }).catalog;
  const generated = schema({
    tables: [table("stats", { total: t.integer().generated("1") })],
  }).catalog;
  const placed = placeCatalog(schema({ tables: [users] }).catalog, "app", new Map());
  const extended = schema({
    tables: [table("users", { id: t.id() })],
    extensions: [extension("vector")],
  }).catalog;
  const secured = schema({
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [table("notes", { id: t.uuid().primaryKey(), body: t.text() })],
  }).catalog;
  const roles = attachRoles(schema({ tables: [table("users", { id: t.id() })] }).catalog, {
    migration: "okm_migrate",
    app: "okm_app",
  });
  return [
    identity,
    uuid,
    uuidv7,
    jsonb,
    arrays,
    range,
    enumerated,
    domain,
    partial,
    expression,
    generated,
    placed,
    extended,
    secured,
    roles,
  ];
}

test("a schema the profile refuses fails in the planner", () => {
  const after = schema({ tables: [table("notes", { id: t.text().primaryKey() })] }).catalog;
  const dialect: DdlDialect = {
    name: "closed",
    support(feature) {
      return closed[feature]?.support;
    },
    featuresUsed,
    refuseUnsupported(features) {
      return assertSupported(features, closed, "closed");
    },
    lower() {
      return [];
    },
  };
  expect(() => planMigration({ name: "probe", before: after, after }, dialect)).toThrow(OkmError);
});

test("catalog features are refused through featuresUsed", () => {
  const seen = new Set<string>();
  for (const catalog of catalogs()) {
    const used = featuresUsed(catalog);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) {
      seen.add(key);
      refuse(key);
    }
  }
  expect(seen.has("schema.core")).toBe(true);
  expect(seen.has("type.uuid")).toBe(true);
  expect(seen.has("policies.table")).toBe(true);
  expect(seen.has("roles.grants")).toBe(true);
  const missed = Object.keys(closed).filter((key) => !seen.has(key));
  expect(missed.length).toBeGreaterThan(0);
  for (const key of missed) refuse(key);
});

test("the refused profile matches the suite titles", () => {
  const titles = collectTestTitles([
    join(repoRoot(), "tests"),
    join(repoRoot(), "packages/harness"),
  ]);
  expect(registryProblems(closed, titles)).toEqual([]);
});

test("the profile counts portable, gated, refusal, and unsupported", async () => {
  const marks = collectConformanceMarks(
    { capabilities: CLOSED_CAPABILITIES, registry: closed, dialect: "closed" },
    false,
  );
  const counts = { portable: 0, gated: 0, refusal: 0, unsupported: 0 };
  for (const mark of marks) {
    if (mark.outcome === "refusal") {
      counts.refusal += 1;
      if (mark.fn === undefined) throw new Error(`refusal without a body: ${mark.title}`);
      await mark.fn();
    } else if (mark.outcome === "unsupported") counts.unsupported += 1;
    else if (mark.tier.kind === "portable") counts.portable += 1;
    else counts.gated += 1;
  }
  expect(counts).toEqual({ portable: 0, gated: 0, refusal: 71, unsupported: 11 });
  expect(formatConformanceCounts(counts)).toBe(
    "counts\tportable\t0\tgated\t0\trefusal\t71\tunsupported\t11",
  );
});

test("a profile with every flag runs portable and gated cases", () => {
  const marks = collectConformanceMarks({
    capabilities: { transactions: "interactive", stream: true, listen: true, cancel: true },
  });
  const counts = { portable: 0, gated: 0, refusal: 0, unsupported: 0 };
  for (const mark of marks) {
    if (mark.outcome === "refusal") counts.refusal += 1;
    else if (mark.outcome === "unsupported") counts.unsupported += 1;
    else if (mark.tier.kind === "portable") counts.portable += 1;
    else counts.gated += 1;
  }
  expect(counts).toEqual({ portable: 0, gated: 82, refusal: 0, unsupported: 0 });
});

test("transactions none is OKM1111 and names batch as the alternative", async () => {
  const pool = openClosedDriver();
  const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
  const db = createClient(schema({ tables: [notes] }), pool, { ownsPool: false });
  await db.connected;
  const error = await rejection(db.tx(async () => 1));
  expect(error.code).toBe("OKM1111");
  expect(error.message).toContain('transactions: "interactive"');
  expect(error.message).toContain('has "none"');
  expect(error.fix.summary).toContain("batch()");
  await pool.close();
});

test("cancel false refuses a positive timeout with OKM1120 and no alternative", async () => {
  const pool = openClosedDriver();
  const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
  const db = createClient(schema({ tables: [notes] }), pool, { ownsPool: false });
  await db.connected;
  const error = await rejection(db.tx({ timeout: 20 }, async () => 1));
  expect(error.code).toBe("OKM1120");
  expect(error.message).toBe("timeout");
  expect(error.fix.summary).not.toContain("Portable substitute");
  await pool.close();
});

test("stream, listen, prepared, and describe do not refuse", async () => {
  const pool = openClosedDriver();
  const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
  const db = createClient(schema({ tables: [notes] }), pool, { ownsPool: false });
  await db.connected;
  let streamCode = "";
  try {
    for await (const _row of db.notes.find({ limit: 1 }).stream()) {
      streamCode = "yielded";
    }
    if (streamCode === "") streamCode = "completed";
  } catch (error) {
    streamCode = error instanceof OkmError ? error.code : "throw";
  }
  expect(streamCode).not.toBe("OKM1111");
  expect(Object.hasOwn(pool, "listen")).toBe(false);
  expect(Object.hasOwn(pool, "describe")).toBe(false);
  expect(Object.keys(CLOSED_CAPABILITIES).sort()).toEqual([...CAPABILITY_NAMES].sort());
  expect("prepared" in CLOSED_CAPABILITIES).toBe(false);
  expect("describe" in CLOSED_CAPABILITIES).toBe(false);
  await pool.close();
});

const minimum: SuiteTest = (name, fn) => {
  test(name, fn);
};
minimum.skip = (name, fn) => {
  test.skip(name, fn);
};
const tiers: string[] = [];
minimum.note = (_name, tier) => {
  tiers.push(tier.kind);
};
const port = portable(minimum);

port("portable minimum: connect", async () => {
  const pool = openClosedDriver();
  const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
  const db = createClient(schema({ tables: [notes] }), pool, { ownsPool: false });
  await db.connected;
  expect(db.capabilities).toEqual(CLOSED_CAPABILITIES);
  await pool.close();
});

port("portable minimum: read and write", async () => {
  const pool = openClosedDriver();
  await pool.execute("insert into notes (id, body) values ($1, $2)", ["a", "hello"]);
  const read = await pool.execute("select body from notes where id = $1", ["a"]);
  expect(read.rows).toEqual([["hello"]]);
  const one = await pool.execute("select 1::text as n");
  expect(one.rows).toEqual([["1"]]);
  await pool.close();
});

port("portable minimum: map a unique violation", async () => {
  const pool = openClosedDriver();
  await pool.execute("insert into notes (id, body) values ($1, $2)", ["a", "hello"]);
  const error = await driverFailure(
    pool.execute("insert into notes (id, body) values ($1, $2)", ["a", "again"]),
  );
  const mapped = mapPostgresError(error);
  expect(mapped).toBeInstanceOf(OkmError);
  expect(mapped.kind).toBe("unique");
  await pool.close();
});

test("the portable minimum cases are tagged portable", () => {
  expect(tiers).toEqual(["portable", "portable", "portable"]);
});

async function rejection(promise: Promise<unknown>): Promise<OkmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function driverFailure(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DriverError) return error;
    throw error;
  }
  throw new Error("expected a driver error");
}

test("refusal:schema.core", () => refuse("schema.core"));
test("refusal:schema.identity", () => refuse("schema.identity"));
test("refusal:type.uuid", () => refuse("type.uuid"));
test("refusal:type.uuidv7", () => refuse("type.uuidv7"));
test("refusal:type.jsonb", () => refuse("type.jsonb"));
test("refusal:type.array", () => refuse("type.array"));
test("refusal:type.range", () => refuse("type.range"));
test("refusal:type.enum", () => refuse("type.enum"));
test("refusal:type.domain", () => refuse("type.domain"));
test("refusal:index.partial", () => refuse("index.partial"));
test("refusal:index.expression", () => refuse("index.expression"));
test("refusal:column.generated", () => refuse("column.generated"));
test("refusal:namespace", () => refuse("namespace"));
test("refusal:extension", () => refuse("extension"));
test("refusal:query.relational", () => refuse("query.relational"));
test("refusal:query.keyset", () => refuse("query.keyset"));
test("refusal:query.window", () => refuse("query.window"));
test("refusal:query.rawTyped", () => refuse("query.rawTyped"));
test("refusal:query.upsert", () => refuse("query.upsert"));
test("refusal:returning.write", () => refuse("returning.write"));
test("refusal:bulk.insert", () => refuse("bulk.insert"));
test("refusal:atomic.json", () => refuse("atomic.json"));
test("refusal:atomic.array", () => refuse("atomic.array"));
test("refusal:query.stream", () => refuse("query.stream"));
test("refusal:tx.interactive", () => refuse("tx.interactive"));
test("refusal:tx.savepoints", () => refuse("tx.savepoints"));
test("refusal:tx.isolation", () => refuse("tx.isolation"));
test("refusal:tx.retry", () => refuse("tx.retry"));
test("refusal:lock.row", () => refuse("lock.row"));
test("refusal:lock.skip", () => refuse("lock.skip"));
test("refusal:lock.advisory", () => refuse("lock.advisory"));
test("refusal:listen.notify", () => refuse("listen.notify"));
test("refusal:steps.resumable", () => refuse("steps.resumable"));
test("refusal:tenancy.column", () => refuse("tenancy.column"));
test("refusal:tenancy.rls", () => refuse("tenancy.rls"));
test("refusal:policies.table", () => refuse("policies.table"));
test("refusal:session.settings", () => refuse("session.settings"));
test("refusal:roles.grants", () => refuse("roles.grants"));
test("refusal:guard.fragment", () => refuse("guard.fragment"));
test("refusal:guard.pooler", () => refuse("guard.pooler"));
test("refusal:tooling.introspect", () => refuse("tooling.introspect"));
test("refusal:tooling.lint", () => refuse("tooling.lint"));
test("refusal:tooling.pull", () => refuse("tooling.pull"));
test("refusal:tooling.scratchReplay", () => refuse("tooling.scratchReplay"));
test("refusal:tooling.testing", () => refuse("tooling.testing"));
test("refusal:tooling.describe", () => refuse("tooling.describe"));
