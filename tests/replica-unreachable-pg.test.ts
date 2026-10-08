/**
 * A dead replica falls back to the primary on each real driver (QA-M1).
 *
 * The replica is `127.0.0.1:1`, where nothing listens, so the connect is
 * refused. The primary is a fresh database on the topology. Runs under
 * `bun run db:up`; `REQUIRE_DOCKER=1` fails the suite when the topology is down.
 */

import { expect } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectNodePostgres } from "../src/runtime/pg/pg.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";
import type { RouteEvent, RoutedClient } from "../src/runtime/topology.js";
import { createIsolatedDatabase, withPostgres } from "../packages/harness/src/postgres.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const DEAD_REPLICA = "postgres://okm:okm@127.0.0.1:1/okm";

const gate = await loadPostgresGate();
requirePostgresWhenAsked(gate);

type Driver = "postgresjs" | "pg" | "bun";
type Db = RoutedClient<typeof app>;

/** Each driver test runs against a topology that may be slow to answer under load. */
const run = (name: string, fn: () => Promise<void>): void => postgresTest(gate, name, fn, 60_000);

const connectors: Record<Driver, (primary: string, events: RouteEvent[]) => Promise<Db>> = {
  postgresjs: (primary, events) =>
    connectPostgresJs(
      { primary, replicas: [DEAD_REPLICA] },
      { schema: app, routing: { probe: 60_000 }, onRoute: (event) => events.push(event) },
    ),
  pg: (primary, events) =>
    connectNodePostgres(
      { primary, replicas: [DEAD_REPLICA] },
      { schema: app, routing: { probe: 60_000 }, onRoute: (event) => events.push(event) },
    ),
  bun: (primary, events) =>
    connectBun(
      { primary, replicas: [DEAD_REPLICA] },
      { schema: app, routing: { probe: 60_000 }, onRoute: (event) => events.push(event) },
    ),
};

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  run(`${driver}: a read on a refused replica falls back to the primary`, async () => {
    const database = await createIsolatedDatabase();
    try {
      await withPostgres(
        (sql) =>
          sql.unsafe(
            "create table notes (id text primary key, title text); insert into notes values ('seed', 'first')",
          ),
        database.url,
      );
      const events: RouteEvent[] = [];
      const db = await connectors[driver](database.url, events);
      try {
        await db.connected;
        events.length = 0;
        const rows = await db.notes.find({ limit: 5 });
        expect(rows.map((row) => row.title)).toEqual(["first"]);
        expect(events.at(-1)).toEqual({
          op: "read",
          endpoint: "primary",
          reason: "fallback:unhealthy",
        });
      } finally {
        await db.close();
      }
    } finally {
      await database.close();
    }
  });

  run(`${driver}: twenty reads race the refused replica and all resolve`, async () => {
    const database = await createIsolatedDatabase();
    try {
      await withPostgres(
        (sql) =>
          sql.unsafe(
            "create table notes (id text primary key, title text); insert into notes values ('seed', 'first')",
          ),
        database.url,
      );
      const events: RouteEvent[] = [];
      const db = await connectors[driver](database.url, events);
      try {
        await db.connected;
        const reads = await Promise.all(
          Array.from({ length: 20 }, () => db.notes.find({ limit: 5 })),
        );
        expect(reads.every((rows) => rows.length === 1 && rows[0]?.title === "first")).toBe(true);
        expect(
          events.every((event) =>
            event.endpoint === "replica-1"
              ? event.reason.startsWith("auto:")
              : event.reason === "fallback:unhealthy" || event.reason === "primary-required",
          ),
        ).toBe(true);
        expect(events.some((event) => event.reason === "fallback:unhealthy")).toBe(true);
      } finally {
        await db.close();
      }
    } finally {
      await database.close();
    }
  });

  run(`${driver}: a refused replica with fallback error names the failure`, async () => {
    const database = await createIsolatedDatabase();
    try {
      await withPostgres(
        (sql) =>
          sql.unsafe(
            "create table notes (id text primary key, title text); insert into notes values ('seed', 'first')",
          ),
        database.url,
      );
      const db = await connectors[driver](database.url, []);
      try {
        await db.connected;
        let message = "";
        try {
          await db.notes.find({ limit: 1, route: "replica" });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message.length).toBeGreaterThan(0);
      } finally {
        await db.close();
      }
    } finally {
      await database.close();
    }
  });
}
