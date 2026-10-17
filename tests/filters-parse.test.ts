/**
 * `filters().parse` applies every operator the allow type names.
 *
 * Relation fields become `has`. A value JSON can build is not an operator.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { parseQuery } from "../src/dialects/pg/filter-parse.js";
import { many, schema, t, table } from "../src/dialects/pg/index.js";
import { isOperator, operatorName, operatorValue } from "../src/dialects/pg/operators.js";
import { connect } from "../src/runtime/pg/pglite.js";

const items = table("items", {
  id: t.text().primaryKey(),
  name: t.text(),
  ownerId: t.text().references("owners"),
});
const owners = table(
  "owners",
  { id: t.text().primaryKey() },
  { relations: { list: many("items", "ownerId") } },
);
const hidden = table("secrets", {
  id: t.text().primaryKey(),
  title: t.text().hidden(),
  name: t.text(),
});
const readers = table(
  "readers",
  { id: t.text().primaryKey() },
  { relations: { list: many("secrets", "id") } },
);
const app = schema({ tables: [owners, items] });

test("parse applies not, containment, and json keys", async () => {
  const tasks = table("tasks", {
    id: t.text().primaryKey(),
    title: t.text(),
    tags: t.text().array(),
    meta: t.jsonb(),
  });
  const parsed = await tasks
    .filters({
      allow: {
        title: ["not", "eq"],
        tags: ["containedBy", "overlaps"],
        meta: ["hasKey", "hasAnyKey"],
      },
    })
    .parse({
      title: { not: "x" },
      tags: { overlaps: ["a"], containedBy: ["a", "b"] },
      meta: { hasKey: "published", hasAnyKey: ["published", "title"] },
    });
  expect(isOperator(parsed.where)).toBe(true);
  if (!isOperator(parsed.where)) return;
  expect(operatorName(parsed.where)).toBe("and");
  const parts = operatorValue(parsed.where);
  expect(Array.isArray(parts)).toBe(true);
  const names: string[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const value = Object.values(part)[0];
      if (isOperator(value)) names.push(operatorName(value));
    }
  }
  expect(names).toEqual(["not", "overlaps", "containedBy", "hasKey", "hasAnyKey"]);
  expect(
    await code(tasks.filters({ allow: { title: ["not"] } }).parse({ title: { not: { eq: "x" } } })),
  ).toBe("OKM1120");
  expect(
    await code(
      tasks.filters({ allow: { meta: ["hasAnyKey"] } }).parse({ meta: { hasAnyKey: ["a", 1] } }),
    ),
  ).toBe("OKM1120");
  expect(await code(tasks.filters({ allow: { title: ["path" as never] } }).parse({}))).toBe(
    "OKM1120",
  );
});

test("a relation allowlist becomes has, and a column name wins", async () => {
  const parsed = await owners
    .filters({ relations: { list: ["name"] } })
    .parse({ list: { name: { startsWith: "Work" } } });
  const list = parsed.where.list;
  expect(isOperator(list)).toBe(true);
  if (!isOperator(list)) return;
  expect(operatorName(list)).toBe("has");
  const inner = operatorValue(list);
  expect(isOperator(inner) ? operatorName(inner) : "").toBe("");
  if (typeof inner === "object" && inner !== null && "name" in inner) {
    expect(isOperator(inner.name)).toBe(true);
    if (isOperator(inner.name)) expect(operatorName(inner.name)).toBe("startsWith");
  }
  expect(
    await code(owners.filters({ relations: { list: ["name"] } }).parse({ list: { title: "a" } })),
  ).toBe("OKM1123");
  expect(
    await code(
      owners.filters({ relations: { list: ["name"] } }).parse({ list: { name: { path: "a" } } }),
    ),
  ).toBe("OKM1120");
  const column = parseQuery({ list: ["eq"] }, [], { list: "x" }, { list: ["name"] });
  expect(column).toEqual({ where: { list: "x" } });
  const db = await connect(stub(), { schema: app });
  const described = await db.owners
    .find({ where: parsed.where as { readonly id: string }, limit: 1 })
    .sql();
  expect(described.text).toContain("exists (select 1 from");
  expect(described.text.includes("Work")).toBe(false);
  expect(described.params.some((param) => param?.replaceAll("\\", "").includes("Work"))).toBe(true);
  const forged: unknown = JSON.parse(JSON.stringify(parsed.where));
  expect(
    await code(() => db.owners.find({ where: forged as { readonly id: string }, limit: 1 }).sql()),
  ).toBe("OKM1121");
  await db.close();
});

test("a hidden relation field is OKM1123 when filters() is called", () => {
  expect(() => readers.filters({ relations: { list: ["title"] } })).toThrow(OkmError);
  try {
    readers.filters({ relations: { list: ["title"] } });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1123");
  }
  expect(() => hidden.filters({ allow: { title: ["eq"] } })).toThrow(OkmError);
});

test("redefining a table name does not keep a prior hidden mark on filters()", async () => {
  table("tasks", { id: t.text().primaryKey(), title: t.text().hidden() });
  const open = table("tasks", {
    id: t.text().primaryKey(),
    title: t.text(),
    rank: t.integer(),
  });
  const parsed = await open.filters({ allow: { title: ["eq"] }, sort: ["title"] }).parse({
    title: "a",
    sort: "title",
  });
  expect(parsed).toEqual({ where: { title: "a" }, orderBy: { title: "asc" } });
  const stillHidden = table("tasks", {
    id: t.text().primaryKey(),
    title: t.text().hidden(),
  });
  expect(() => stillHidden.filters({ allow: { title: ["eq"] } })).toThrow(OkmError);
  expect(() => readers.filters({ relations: { list: ["title"] } })).toThrow(OkmError);
});

test("request text through parse never becomes SQL", async () => {
  const db = await connect(stub(), { schema: app });
  const safe = fc.string({ minLength: 1, maxLength: 24 }).filter((value) => {
    for (let index = 0; index < value.length; index += 1) {
      const codePoint = value.charCodeAt(index);
      if (codePoint <= 0x1f || codePoint === 0x7f) return false;
    }
    return !value.includes("\\") && !value.includes('"');
  });
  await fc.assert(
    fc.asyncProperty(safe, async (raw) => {
      const marker = `HST_${raw}`;
      const parsed = await owners.filters({ relations: { list: ["name"] } }).parse({
        list: { name: { startsWith: marker } },
      });
      const sql = await db.owners
        .find({ where: parsed.where as { readonly id: string }, limit: 1 })
        .sql();
      expect(sql.text.includes(marker)).toBe(false);
      expect(sql.params.some((param) => param?.replaceAll("\\", "").includes(marker))).toBe(true);
      const forged: unknown = JSON.parse(JSON.stringify(parsed.where));
      expect(
        await code(() =>
          db.owners.find({ where: forged as { readonly id: string }, limit: 1 }).sql(),
        ),
      ).toBe("OKM1121");
    }),
    { numRuns: 20 },
  );
  await db.close();
});

async function code(run: (() => unknown) | Promise<unknown>): Promise<string> {
  try {
    await (typeof run === "function" ? run() : run);
  } catch (error) {
    return error instanceof OkmError ? error.code : "other";
  }
  return "none";
}

function stub(): DriverPool {
  return {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute: () =>
      Promise.resolve({ rows: [["170000", "PostgreSQL 17", null]], count: 1, notices: [] }),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}
