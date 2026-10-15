/**
 * A connection close rejects only a wait that can no longer succeed.
 *
 * postgres.js also closes healthy connections (idle timeout, max lifetime).
 * That close must not fail a queued reserve, and a close in one pool must
 * not fail a wait in another.
 */

import { expect } from "bun:test";
import postgres from "postgres";

import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();

function backendPid(rows: readonly (readonly unknown[])[]): string {
  const cell = rows[0]?.[0];
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  throw new Error("pg_backend_pid");
}

postgresTest(
  gate,
  "closing the other backend does not reject a queued reserve",
  async () => {
    const url = primaryUrl();
    const pool = open({ url, max: 2 });
    const admin = postgres(url, { max: 1, fetch_types: false });
    const held = await pool.reserve?.();
    const other = await pool.reserve?.();
    if (held === undefined || other === undefined) throw new Error("reserve");
    try {
      const otherPid = backendPid((await other.execute("select pg_backend_pid()")).rows);
      let settled = "";
      const queued = pool.reserve?.();
      if (queued === undefined) throw new Error("reserve");
      void queued.then(
        async (connection) => {
          if (connection === undefined) throw new Error("reserve");
          settled = "ok";
          await connection.release();
        },
        () => {
          settled = "bad";
        },
      );
      await admin.unsafe("select pg_terminate_backend($1::int)", [otherPid]);
      const deadline = Date.now() + 8000;
      while (settled === "" && Date.now() < deadline) await Bun.sleep(50);
      expect(settled).toBe("ok");
      expect((await held.execute("select 1")).rows.length).toBe(1);
    } finally {
      await held.release().catch(() => undefined);
      await other.release().catch(() => undefined);
      await admin.end({ timeout: 1 });
      await pool.close();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "a close in one pool does not reject a wait in another",
  async () => {
    const url = primaryUrl();
    const pool1 = open({ url, max: 1 });
    const pool2 = open({ url, max: 1 });
    const admin = postgres(url, { max: 1, fetch_types: false });
    const held1 = await pool1.reserve?.();
    const held2 = await pool2.reserve?.();
    if (held1 === undefined || held2 === undefined) throw new Error("reserve");
    try {
      const pid = backendPid((await held1.execute("select pg_backend_pid()")).rows);
      let settled = "";
      const queued = pool2.reserve?.();
      if (queued === undefined) throw new Error("reserve");
      void queued.then(
        async (connection) => {
          if (connection === undefined) throw new Error("reserve");
          settled = "ok";
          await connection.release();
        },
        () => {
          settled = "bad";
        },
      );
      await admin.unsafe("select pg_terminate_backend($1::int)", [pid]);
      await Bun.sleep(150);
      expect(settled).toBe("");
      await held2.release();
      const deadline = Date.now() + 2000;
      while (settled === "" && Date.now() < deadline) await Bun.sleep(20);
      expect(settled).toBe("ok");
    } finally {
      await held1.release().catch(() => undefined);
      await held2.release().catch(() => undefined);
      await admin.end({ timeout: 1 });
      await pool1.close();
      await pool2.close();
    }
  },
  20_000,
);
