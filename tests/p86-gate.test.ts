/**
 * Gate checks for `filters().parse` that do not need a server.
 *
 * Every operator the allow type names has to apply, and a hostile JSON value
 * stays a parameter or fails as OKM1120, OKM1121, or OKM1123.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { gateRuns } from "./gate-property.js";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { many, schema, t, table } from "../src/dialects/pg/index.js";
import { isOperator, operatorName } from "../src/dialects/pg/operators.js";
import { connect } from "../src/runtime/pg/pglite.js";

const items = table("items", {
  id: t.text().primaryKey(),
  name: t.text(),
  tags: t.text().array(),
  meta: t.jsonb(),
  ownerId: t.text().references("owners"),
});
const owners = table(
  "owners",
  { id: t.text().primaryKey() },
  { relations: { list: many("items", "ownerId") } },
);
const app = schema({ tables: [owners, items] });

const PARSED = [
  "eq",
  "in",
  "inList",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "startsWith",
  "endsWith",
  "contains",
  "like",
  "ilike",
  "not",
  "containedBy",
  "overlaps",
  "hasKey",
  "hasAnyKey",
] as const;

test("parse applies every operator and keeps the value out of the SQL", async () => {
  const marker = "HST_gate_marker";
  const parsed = await items
    .filters({
      allow: {
        name: [
          "eq",
          "in",
          "inList",
          "notIn",
          "lt",
          "lte",
          "gt",
          "gte",
          "between",
          "startsWith",
          "endsWith",
          "contains",
          "like",
          "ilike",
          "not",
        ],
        tags: ["containedBy", "overlaps"],
        meta: ["hasKey", "hasAnyKey"],
      },
    })
    .parse({
      name: {
        eq: marker,
        in: [marker],
        inList: [marker],
        notIn: [marker],
        lt: marker,
        lte: marker,
        gt: marker,
        gte: marker,
        between: [marker, `${marker}_z`],
        startsWith: marker,
        endsWith: marker,
        contains: marker,
        like: `${marker}%`,
        ilike: marker,
        not: marker,
      },
      tags: { containedBy: [marker], overlaps: [marker] },
      meta: { hasKey: marker, hasAnyKey: [marker] },
    });
  expect(isOperator(parsed.where)).toBe(true);
  if (!isOperator(parsed.where)) return;
  expect(operatorName(parsed.where)).toBe("and");
  const names = operatorNames(parsed.where);
  for (const op of PARSED) {
    if (op === "eq") continue;
    expect(names).toContain(op === "in" || op === "inList" ? "inList" : op);
  }
  expect(JSON.stringify(parsed.where)).toContain(marker);

  const db = await connect(stub(), { schema: app });
  try {
    const sql = await db.items
      .find({ where: parsed.where as unknown as { readonly id: string }, limit: 1 })
      .sql();
    expect(sql.text.includes(marker)).toBe(false);
    expect(sql.params.some((param) => JSON.stringify(param).includes(marker))).toBe(true);
  } finally {
    await db.close();
  }
});

test("hostile JSON through parse fails closed or stays a parameter", async () => {
  const filters = items.filters({
    allow: {
      name: [...PARSED],
      tags: ["containedBy", "overlaps", "eq"],
      meta: ["hasKey", "hasAnyKey", "eq"],
    },
  });
  const db = await connect(stub(), { schema: app });
  try {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (value) => {
        const query = {
          name: value,
          sort: "name",
          __proto__: { polluted: true },
          constructor: "no",
        };
        let parsed: { readonly where: unknown } | undefined;
        try {
          parsed = await filters.parse(query);
        } catch (error) {
          expect(error).toBeInstanceOf(OkmError);
          if (error instanceof OkmError) {
            expect(["OKM1120", "OKM1121", "OKM1123"]).toContain(error.code);
          }
          return;
        }
        const sql = await db.items
          .find({ where: parsed.where as unknown as { readonly id: string }, limit: 1 })
          .sql();
        const raw = JSON.stringify(value);
        if (raw.length > 0 && raw !== "null" && raw !== "{}" && raw !== "[]") {
          expect(sql.text.includes(raw)).toBe(false);
        }
        const probe: { polluted?: boolean } = {};
        expect(probe.polluted).toBeUndefined();
      }),
      { numRuns: gateRuns(40) },
    );
  } finally {
    await db.close();
  }
});

test("a relation allowlist rejects a hidden field and an unknown operator", async () => {
  const hidden = table("secrets", {
    id: t.text().primaryKey(),
    title: t.text().hidden(),
  });
  const readers = table(
    "readers",
    { id: t.text().primaryKey(), secretId: t.text().references("secrets") },
    { relations: { secret: many("secrets", "id") } },
  );
  expect(() => readers.filters({ relations: { secret: ["title"] } })).toThrow(OkmError);
  const parsed = await owners.filters({ relations: { list: ["name"] } }).parse({
    list: { name: { ilike: "a", between: ["a", "z"] } },
  });
  const list = parsed.where.list;
  expect(isOperator(list)).toBe(true);
  if (isOperator(list)) expect(operatorName(list)).toBe("has");
  expect(
    await code(
      owners.filters({ relations: { list: ["name"] } }).parse({ list: { name: { path: "a" } } }),
    ),
  ).toBe("OKM1120");
  void hidden;
});

function operatorNames(value: unknown): string[] {
  const names: string[] = [];
  walk(value, names);
  return names;
}

function walk(value: unknown, names: string[]): void {
  if (!isOperator(value)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, names);
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) walk(item, names);
    }
    return;
  }
  names.push(operatorName(value));
  const inner = (value as { readonly value?: unknown }).value;
  walk(inner, names);
}

async function code(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
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
