/**
 * `descendants` and `ancestors` take the same row bound as `find`.
 *
 * `limit` applies after the walk's order. `depth` still counts steps.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { queryObserver } from "../src/runtime/observe.js";
import type { QueryEvent } from "../src/runtime/observe-types.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";
import { app, TENANT_A } from "./tree-sync-schema.js";

const row = (n: number): string =>
  `01890c5a-8f0e-7c3a-9b2d-6e4f1a0c${n.toString(16).padStart(4, "0")}`;

async function seeded() {
  const pool = await open();
  for (const statement of renderCatalog(app.catalog, "public")) {
    await pool.execute(statement);
  }
  const db = await connect(pool, { schema: app });
  const a = db.for({ tenantId: TENANT_A });
  await a.nodes.insert({ id: row(1), name: "root", parentId: null, managerId: null });
  await a.nodes.insert({ id: row(2), name: "mid", parentId: row(1), managerId: row(1) });
  await a.nodes.insert({ id: row(3), name: "keep", parentId: row(2), managerId: null });
  await a.nodes.insert({ id: row(4), name: "drop", parentId: row(2), managerId: null });
  await a.nodes.insert({ id: row(5), name: "other", parentId: row(1), managerId: null });
  return { pool, db, a };
}

function names(rows: readonly { readonly name: string }[]): string[] {
  return rows.map((item) => item.name);
}

async function code(pending: PromiseLike<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  return "";
}

async function failure(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

test("limit bounds the rows after the walk order, and depth still counts steps", async () => {
  const { pool, a } = await seeded();
  try {
    const walk = { relation: "children" } as const;
    expect(names(await a.nodes.descendants(row(1), { ...walk, limit: 2 }))).toEqual([
      "mid",
      "other",
    ]);
    expect(names(await a.nodes.descendants(row(1), { ...walk, limit: 1 }))).toEqual(["mid"]);
    expect(names(await a.nodes.descendants(row(1), { ...walk, depth: 1, limit: 20 }))).toEqual([
      "mid",
      "other",
    ]);
    expect(
      names(await a.nodes.descendants(row(1), { ...walk, orderBy: { name: "asc" }, limit: 1 })),
    ).toEqual(["drop"]);
    expect(names(await a.nodes.ancestors(row(3), { ...walk, limit: 1 }))).toEqual(["mid"]);
    expect(names(await a.nodes.ancestors(row(3), { ...walk, limit: 2 }))).toEqual(["mid", "root"]);

    const sql = await a.nodes.descendants(row(1), { ...walk, limit: 2 }).sql();
    expect(sql.text.indexOf("order by")).toBeLessThan(sql.text.lastIndexOf(" limit "));
    expect(sql.text.indexOf(") select")).toBeLessThan(sql.text.lastIndexOf(" limit "));
    expect(sql.params.at(-1)).toBe("2");
    const depth = await a.nodes.descendants(row(1), { ...walk, depth: 1, limit: 2 }).sql();
    expect(depth.text).toContain("w.depth < 1");
    expect(depth.text.lastIndexOf(" limit ")).toBeGreaterThan(depth.text.indexOf("w.depth < 1"));

    const open = await failure(a.nodes.descendants(row(1), walk));
    expect(open.code).toBe("OKM1101");
    expect(open.message).toContain("descendants() needs a limit.");
    const up = await failure(a.nodes.ancestors(row(3), walk));
    expect(up.code).toBe("OKM1101");
    expect(up.message).toContain("ancestors() needs a limit.");
    expect(await code(a.nodes.descendants(row(1), { ...walk, depth: 1 }))).toBe("OKM1101");
    const empty = await failure(a.nodes.descendants(row(1), walk).all(""));
    expect(empty.code).toBe("OKM1101");
    expect(empty.message).toContain("descendants() .all needs a reason.");
    const all = await a.nodes.descendants(row(1), walk).all("export").sql();
    expect(all.text).not.toContain(" limit ");
    expect(names(await a.nodes.descendants(row(1), walk).all("export"))).toEqual([
      "mid",
      "other",
      "keep",
      "drop",
    ]);
  } finally {
    await pool.close();
  }
});

test("limits.find, limits.max, inspect, onQuery, and OKM2011 follow find", async () => {
  const { pool } = await seeded();
  try {
    const notices: WarningNotice[] = [];
    const events: QueryEvent[] = [];
    const bounded = await connect(pool, {
      schema: app,
      limits: { find: 2, max: 3 },
      warnings: warnings({ env: "development", onWarning: (notice) => notices.push(notice) }),
      onQuery: queryObserver({ query: (event) => void events.push(event) }),
    });
    const a = bounded.for({ tenantId: TENANT_A });
    const walk = { relation: "children" } as const;
    expect(names(await a.nodes.descendants(row(1), walk))).toEqual(["mid", "other"]);
    const inspected = await a.nodes.descendants(row(1), walk).inspect();
    expect(inspected.intent.limit).toBe(2);
    expect(inspected.rules.find((rule) => rule.rule === "bounded")).toEqual({
      rule: "bounded",
      contribution: "limits.find",
      provenance: "connect",
    });
    const written = await a.nodes.ancestors(row(3), { ...walk, limit: 1 }).inspect();
    expect(written.rules.find((rule) => rule.rule === "bounded")).toEqual({
      rule: "bounded",
      contribution: "limit",
      provenance: "caller",
    });
    const over = await failure(a.nodes.descendants(row(1), { ...walk, limit: 4 }));
    expect(over.code).toBe("OKM1101");
    expect(over.message).toContain("limits.max (3)");
    expect(names(await a.nodes.descendants(row(1), { ...walk, limit: 4 }).all("export"))).toEqual([
      "mid",
      "other",
      "keep",
      "drop",
    ]);
    expect(
      events.filter((event) => event.op === "descendants").map((event) => event.limit),
    ).toEqual([
      { value: 2, source: "limits.find" },
      { value: 4, source: "caller" },
    ]);
    expect(
      notices.filter((notice) => notice.code === "OKM2011").map((notice) => notice.limit),
    ).toEqual(["limits.find = 2"]);
  } finally {
    await pool.close();
  }
});
