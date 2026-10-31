/**
 * SQL shape of a tree walk and of `sync`, with no database.
 *
 * The statements are planned here. Rows, cycles, and locks are in the Postgres file.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { createClient } from "../src/runtime/client.js";
import { app, TENANT_A } from "./tree-sync-schema.js";

const ID = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c0001";
const OTHER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c0002";

const pool = {
  calls: 0,
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute() {
    this.calls += 1;
    return Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] });
  },
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool & { calls: number };

const db = createClient(app, pool, { ownsPool: false });
const a = db.for({ tenantId: TENANT_A });

test("a walk is one recursive statement and a cycle cannot repeat a row", async () => {
  const sql = await a.nodes.descendants(ID, { relation: "children", limit: 20 }).sql();
  expect(sql.text).toContain("with recursive");
  expect(sql.text).toContain("<> all(w.seen)");
  expect(sql.text).toContain('c."parent_id" = w.k0');
  expect(sql.text).not.toContain('c."manager_id" = w.k0');
  expect(sql.text).toContain("where w.depth > 0");
  const reports = await a.nodes.ancestors(ID, { relation: "reports", depth: 1, limit: 20 }).sql();
  expect(reports.text).toContain('s."manager_id" as f0');
  expect(reports.text).toContain('c."id" = w.f0');
  expect(reports.text).toContain("w.depth < 1");
  const self = await a.nodes.descendants(ID, { relation: "children", self: true, limit: 20 }).sql();
  expect(self.text).not.toContain("w.depth > 0");
});

test("two self-relations need a name", async () => {
  const error = await catchError(Promise.resolve(a.nodes.descendants(ID, { limit: 1 }).sql()));
  expect(error.code).toBe("OKM1120");
  expect(error.message).toContain("relation");
});

test("the active set is in the walk, and withArchived leaves it out", async () => {
  const active = await a.nodes.descendants(ID, { relation: "children", limit: 20 }).sql();
  expect(active.text).toContain('archived_at" is null');
  const archived = await a.nodes
    .withArchived()
    .descendants(ID, { relation: "children", limit: 20 })
    .sql();
  expect(archived.text).not.toContain('archived_at" is null');
});

test("sync locks the parent and refuses a link that would delete a row", async () => {
  await db.connected;
  const before = pool.calls;
  const sql = await a.tags.sync(ID, "nodes", [OTHER, OTHER]).sql();
  const text = sql.statements.map((statement) => statement.text).join("\n");
  expect(text).toContain("for update");
  expect(text).toContain("materialized");
  expect(text).toContain("distinct");
  const write = sql.statements[1];
  if (write === undefined) throw new Error("sync sql has no write statement");
  expect((write.params ?? []).filter((value) => value === OTHER)).toEqual([OTHER]);
  const items = await catchError(a.folders.sync(ID, "items", []).sql());
  expect(items.code).toBe("OKM1120");
  expect(items.message).toContain("not nullable");
  const noted = await catchError(a.tags.sync(ID, "noted", [OTHER]).sql());
  expect(noted.code).toBe("OKM1120");
  expect(noted.message).toContain("cannot fill");
  const parent = await catchError(a.nodes.sync(ID, "parent", []).sql());
  expect(parent.code).toBe("OKM1120");
  expect(parent.message).toContain("to-many");
  const self = await catchError(a.nodes.sync(ID, "children", [ID]).sql());
  expect(self.code).toBe("OKM1120");
  expect(self.message).toContain("tree");
  const follows = await a.nodes.sync(ID, "follows", [ID, OTHER]).sql();
  expect(follows.statements).toHaveLength(2);
  const cycle = await catchError(
    a.nodes.update({ where: { id: ID }, set: { parentId: ID } }).sql(),
  );
  expect(cycle.code).toBe("OKM1120");
  expect(cycle.message).toContain("tree");
  const other = await a.nodes.update({ where: { id: ID }, set: { parentId: OTHER } }).sql();
  expect(other.statements[0]?.text).toContain("update");
  expect(other.statements[0]?.text).toContain("with recursive");
  const filtered = await a.nodes.update({ where: { name: "root" }, set: { parentId: ID } }).sql();
  expect(filtered.statements[0]?.text).toContain("update");
  expect(filtered.statements[0]?.text).not.toContain("with recursive");
  const returned = await a.nodes
    .update(
      { where: { name: "root" }, set: { name: "next" }, limit: 1, lock: "skip" },
      { returning: true },
    )
    .sql();
  expect(returned.statements[0]?.text).toContain("returning");
  const counted = await a.nodes
    .update({ where: { name: "root" }, set: { name: "next" }, limit: 1, lock: "skip" })
    .sql();
  expect(counted.statements[0]?.text).not.toContain("returning");
  const kept = await a.nodes.sync(ID, "children", [OTHER]).sql();
  expect(kept.statements).toHaveLength(2);
  const cross = await a.tags.sync(ID, "nodes", [ID]).sql();
  expect(cross.statements).toHaveLength(2);
  expect(pool.calls).toBe(before);
});

async function catchError(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
