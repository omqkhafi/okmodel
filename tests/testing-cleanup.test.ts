/**
 * `testing()` drops the catalog it applied when the harness finishes.
 *
 * PGlite covers the drop, a second apply in the same database, dependency
 * order, `migrate: false`, a thrown body, and a drop the database rejects.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import { enum as enumColumn, id, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { global, rlsTenancy } from "../src/runtime/tenancy/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { testing } from "../src/tooling/testing/index.js";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});

const users = table("users", { id: id(), name: text() });
const accounts = table("accounts", {
  id: id({ default: "none" }),
  name: text(),
  userId: uuid().references("users"),
});

const linked = schema({ tables: [accounts, users] });
const plain = schema({ tables: [notes] });

test("close drops applied objects so a second testing() can use the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-testing-"));
  try {
    const first = await testing(linked, { driver: openPglite({ dataDir: dir }) });
    await first.close();

    const look = await openPglite({ dataDir: dir });
    try {
      expect(await relationNames(look)).toEqual([]);
      expect(await enumNames(look)).toEqual([]);
    } finally {
      await look.close();
    }

    const second = await testing(linked, { driver: openPglite({ dataDir: dir }) });
    try {
      expect(await second.db.accounts.find({ limit: 1 })).toEqual([]);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a view, matview, enum, function, and policy drop in dependency order", async () => {
  const notesWithStatus = table("notes", {
    id: id({ default: "none" }),
    title: text(),
    status: enumColumn("note_status", ["open", "closed"]),
  });
  const app = schema({
    tables: [notesWithStatus],
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    functions: [
      fn("note_open", {
        returns: "boolean",
        language: "sql",
        body: "select $1 = 'open'",
        arguments: [{ name: "status", type: "note_status" }],
        dependsOn: [notesWithStatus],
      }),
    ],
    views: [
      view("open_notes", {
        columns: [
          { name: "id", type: "uuid" },
          { name: "title", type: "text" },
        ],
        query: "select id, title from notes where status = 'open'",
        tenancy: global("open notes"),
      }),
      materializedView("note_titles", {
        columns: [
          { name: "id", type: "uuid" },
          { name: "title", type: "text" },
        ],
        query: "select id, title from notes",
        indexes: [{ columns: ["id"], unique: true }],
        tenancy: global("titles"),
      }),
    ],
  });
  const log: string[] = [];
  const pool = await openPglite();
  const harness = await testing(app, { driver: spy(pool, log) });
  const from = log.length;
  await harness.close();
  const drops = log.slice(from).map((sql) => sql.toLowerCase());
  const at = (pattern: RegExp): number => drops.findIndex((sql) => pattern.test(sql));
  const viewAt = at(/^drop view /);
  const matviewAt = at(/^drop materialized view /);
  const functionAt = at(/^drop function /);
  const policyAt = at(/^drop policy /);
  const tableAt = at(/^drop table .*notes/);
  const typeAt = at(/^drop type .*note_status/);
  expect(viewAt).toBeGreaterThanOrEqual(0);
  expect(matviewAt).toBeGreaterThanOrEqual(0);
  expect(functionAt).toBeGreaterThanOrEqual(0);
  expect(policyAt).toBeGreaterThanOrEqual(0);
  expect(tableAt).toBeGreaterThanOrEqual(0);
  expect(typeAt).toBeGreaterThanOrEqual(0);
  expect(viewAt).toBeLessThan(tableAt);
  expect(matviewAt).toBeLessThan(tableAt);
  expect(policyAt).toBeLessThan(tableAt);
  expect(functionAt).toBeLessThan(typeAt);
  expect(tableAt).toBeLessThan(typeAt);
  expect(drops[viewAt]).toContain("cascade");
  expect(drops[matviewAt]).toContain("cascade");
  expect(drops[functionAt]).toContain("cascade");
  expect(drops[tableAt]).not.toContain("cascade");
});

test("migrate: false drops nothing", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(plain.catalog, "public")) {
      if (statement.trim().length === 0) continue;
      await pool.execute(statement);
    }
    const before = await relationNames(pool);
    expect(before).toContain("notes");
    const harness = await testing(plain, { driver: hold(pool), migrate: false });
    await harness.close();
    expect(await relationNames(pool)).toEqual(before);
  } finally {
    await pool.close();
  }
});

test("a thrown body still drops the objects testing() applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-testing-body-"));
  try {
    let thrown: unknown;
    try {
      const harness = await testing(plain, { driver: openPglite({ dataDir: dir }) });
      try {
        throw new Error("body failed");
      } finally {
        await harness.close();
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toBe("body failed");

    const look = await openPglite({ dataDir: dir });
    try {
      expect(await relationNames(look)).toEqual([]);
    } finally {
      await look.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ignored table is not created and is not dropped", async () => {
  const kept = table("kept", { id: id({ default: "none" }), title: text() });
  const app = schema({ tables: [notes, kept] });
  const stamped = { ...app, catalog: stampOwnership(app.catalog, new Map([["kept", "ignored"]])) };
  const pool = await openPglite();
  try {
    await pool.execute(`create table kept (id uuid primary key, title text)`);
    const harness = await testing(stamped, { driver: hold(pool) });
    await harness.close();
    const names = await relationNames(pool);
    expect(names).toContain("kept");
    expect(names).not.toContain("notes");
  } finally {
    await pool.close();
  }
});

test("a failed drop is reported after the pool is closed", async () => {
  const pool = await openPglite();
  let poolClosed = false;
  const wrapped: DriverPool = {
    ...pool,
    execute: (text, params, options) => pool.execute(text, params, options),
    async close() {
      poolClosed = true;
      await pool.close();
    },
  };
  const harness = await testing(plain, { driver: wrapped });
  await pool.execute(`create view extra as select id, title from notes`);
  let failure: unknown;
  try {
    await harness.close();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OkmError);
  expect(failure instanceof OkmError ? failure.message : "").toContain("could not drop");
  expect(failure instanceof OkmError ? failure.message : "").toContain("notes");
  expect(poolClosed).toBe(true);
  let after: unknown;
  try {
    await pool.execute("select 1");
  } catch (error) {
    after = error;
  }
  expect(after).toBeDefined();
});

/**
 * Relation names in `public`.
 *
 * @param pool - Open pool
 * @returns Table, view, matview, and sequence names
 */
async function relationNames(pool: DriverPool): Promise<readonly string[]> {
  const result = await pool.execute(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S') order by 1`,
  );
  return result.rows.map((row) => String(row[0]));
}

/**
 * Enum type names in `public`.
 *
 * @param pool - Open pool
 * @returns Enum names
 */
async function enumNames(pool: DriverPool): Promise<readonly string[]> {
  const result = await pool.execute(
    `select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e' order by 1`,
  );
  return result.rows.map((row) => String(row[0]));
}

/**
 * Records statements and still closes the real pool.
 *
 * @param pool - Real pool
 * @param log - Statement log
 * @returns A pool `testing()` can own
 */
function spy(pool: DriverPool, log: string[]): DriverPool {
  return {
    ...pool,
    execute(text, params, options) {
      log.push(text);
      return pool.execute(text, params, options);
    },
  };
}

/**
 * Forwards statements and leaves the real pool open.
 *
 * @param pool - Real pool
 * @returns A pool whose `close` does not close `pool`
 */
function hold(pool: DriverPool): DriverPool {
  return {
    ...pool,
    close: () => Promise.resolve(),
  };
}
