/**
 * N-134: testing() on a database that is not empty.
 *
 * A pre-installed citext is OKM1894, not a driver error. Two testing() calls
 * on one database that lose the catalog race are OKM1894 as well.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { citext } from "../src/dialects/pg/ext/citext.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { testing } from "../src/tooling/testing/index.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "testing() reports OKM1894 for an existing citext and for a parallel apply",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    try {
      const available = await admin<{ ok: number }[]>`
        select 1 as ok from pg_available_extensions where name = 'citext'
      `;
      if (available.length > 0) {
        await admin.unsafe("create extension citext");
        await admin.unsafe("create table keep (id int primary key)");
        const app = schema({
          tables: [table("notes", { id: t.integer().primaryKey(), email: t.citext() })],
          extensions: [citext()],
        });
        const pool = open({ url: database.url, max: 1 });
        let failure: unknown;
        try {
          const harness = await testing(app, { driver: pool });
          await harness.close();
        } catch (error) {
          failure = error;
        } finally {
          await pool.close().catch(() => undefined);
        }
        expect(failure).toBeInstanceOf(OkmError);
        if (failure instanceof OkmError) {
          expect(failure.code).toBe("OKM1894");
          expect(failure.message).toContain("citext");
          expect(failure.name).not.toBe("DriverError");
        }
        const kept = await admin<{ n: string }[]>`select id::text as n from keep`;
        expect(kept).toEqual([]);
      }

      const notes = schema({
        tables: [table("notes", { id: t.integer().primaryKey(), label: t.text() })],
      });
      let sawConflict = false;
      for (let attempt = 0; attempt < 6 && !sawConflict; attempt += 1) {
        await admin.unsafe("drop table if exists notes cascade");
        const left = open({ url: database.url, max: 1 });
        const right = open({ url: database.url, max: 1 });
        const results = await Promise.allSettled([
          testing(notes, { driver: left }),
          testing(notes, { driver: right }),
        ]);
        for (const result of results) {
          if (result.status === "fulfilled") {
            await result.value.close();
            continue;
          }
          sawConflict = true;
          expect(result.reason).toBeInstanceOf(OkmError);
          if (result.reason instanceof OkmError) {
            expect(result.reason.code).toBe("OKM1894");
            expect(result.reason.message.toLowerCase()).not.toContain("duplicate key");
          }
        }
        await left.close().catch(() => undefined);
        await right.close().catch(() => undefined);
      }
      expect(sawConflict).toBe(true);
    } finally {
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);
