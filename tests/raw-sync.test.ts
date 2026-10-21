/**
 * PGlite: describe fills the lock and does not execute the statement.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/adapters/pg/pglite.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { parseLock } from "../src/tooling/describe/lock.js";
import { discoverRawCalls } from "../src/tooling/describe/scan.js";
import { buildRawLock, commitRawArtifacts, type RawSession } from "../src/tooling/describe/sync.js";

const source = [
  'import { raw } from "okmodel/pg";',
  "export const rows = raw(",
  "  db,",
  '  "select id, title from tasks where id = $1",',
  "  [id],",
  ");",
  'export const saved = raw(db, "insert into tasks (id, title) values ($1, $2)", [id, title]);',
  "",
].join("\n");

test("PGlite types a read and a write without running the write", async () => {
  const pool = await open();
  try {
    await pool.execute("create table tasks (id int primary key, title text)");
    await pool.execute("insert into tasks (id, title) values (1, 'a')");
    const calls = discoverRawCalls([{ path: "src/app.ts", text: source }]);
    const lock = await buildRawLock(calls, "catalog", sessionFrom(pool));
    const read = Object.values(lock.statements).find((item) => item.kind === "read");
    const write = Object.values(lock.statements).find((item) => item.kind === "write");
    expect(read?.columns).toEqual([
      { name: "id", pgType: "integer", nullable: false },
      { name: "title", pgType: "text", nullable: true },
    ]);
    expect(read?.params).toEqual([{ pgType: "integer" }]);
    expect(write?.columns).toEqual([]);
    expect(write?.params.map((param) => param.pgType)).toEqual(["integer", "text"]);
    const count = await pool.execute("select count(*)::int4 from tasks");
    expect(count.rows[0]?.[0]).toBe("1");

    const directory = mkdtempSync(join(tmpdir(), "okm-raw-sync-"));
    expect(() => commitRawArtifacts(directory, calls, lock, undefined, true)).toThrow(OkmError);
    expect(commitRawArtifacts(directory, calls, lock, undefined, false)).toBe(false);
    expect(commitRawArtifacts(directory, calls, lock, undefined, true)).toBe(true);
    const stored = parseLock(readFileSync(join(directory, "raw.lock.json"), "utf8"));
    expect(stored.statements).toEqual(lock.statements);
    expect(readFileSync(join(directory, "raw.d.ts"), "utf8")).toContain(
      "select id, title from tasks where id = $1",
    );
  } finally {
    await pool.close();
  }
}, 20_000);

test("a changed signature is OKM1601 when check would write", async () => {
  const pool = await open();
  try {
    await pool.execute("create table tasks (id int primary key, title text)");
    const calls = discoverRawCalls([{ path: "src/app.ts", text: source }]);
    const lock = await buildRawLock(calls, "catalog", sessionFrom(pool));
    const directory = mkdtempSync(join(tmpdir(), "okm-raw-stale-"));
    commitRawArtifacts(directory, calls, lock, undefined, false);
    const changed = {
      ...lock,
      statements: {
        ...lock.statements,
        [calls[0]?.key ?? ""]: {
          ...Object.values(lock.statements)[0]!,
          columns: [{ name: "id", pgType: "text", nullable: true }],
        },
      },
    };
    expect(() => commitRawArtifacts(directory, calls, changed, undefined, true)).toThrow(OkmError);
  } finally {
    await pool.close();
  }
}, 20_000);

function sessionFrom(pool: DriverPool): RawSession {
  return {
    describe: (sql) => {
      if (pool.describe === undefined) throw new Error("describe is not on the pool");
      return pool.describe(sql);
    },
    query: async (sql) => {
      const result = await pool.execute(sql);
      return result.rows.map((row) => row.map((cell) => (cell == null ? null : String(cell))));
    },
  };
}
