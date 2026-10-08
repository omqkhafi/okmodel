/**
 * Topology conformance on the streaming primary and two hot standbys (P64).
 *
 * `bun run db:up`, then `bun test tests/topology-conformance.test.ts`.
 * `REQUIRE_DOCKER=1` fails these tests when the topology is down.
 * Replay pauses and replica stops take a cluster lock so they do not overlap
 * `tests/replication.test.ts`.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import {
  connectTopology,
  readTopology,
  type ReplicaCandidate,
  type ReplicaState,
  type RouteEvent,
} from "../src/runtime/topology.js";
import { compareLsn } from "../packages/harness/src/lsn.js";
import { isolatedSchemaName } from "../packages/harness/src/schema-name.js";
import { openPostgres } from "../packages/harness/src/postgres.js";
import { startDelayProxy } from "../packages/harness/src/proxy.js";
import {
  loadPostgresGate,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";
import {
  pauseWalReplay,
  readInsertLsn,
  readReplayLsn,
  resumeWalReplay,
  setReplicaContainer,
  waitForReplayLsn,
  withReplicationLock,
} from "../packages/harness/src/replication.js";
import { primaryUrl, replicaUrl, type ReplicaName } from "../packages/harness/src/topology.js";
import type { Sql } from "postgres";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const gate = await loadPostgresGate();
requirePostgresWhenAsked(gate);

const AUDIT = `
create table {{schema}}.note_audit (
  id text,
  pid integer,
  recovering boolean,
  insert_lsn text,
  wal_lsn text
);
create function {{schema}}.capture_lsn() returns trigger language plpgsql as $$
begin
  insert into note_audit (id, pid, recovering, insert_lsn, wal_lsn)
  values (
    coalesce(new.id, old.id),
    pg_backend_pid(),
    pg_is_in_recovery(),
    pg_current_wal_insert_lsn()::text,
    pg_current_wal_lsn()::text
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
create trigger capture_lsn before insert or update or delete on {{schema}}.notes
  for each row execute function {{schema}}.capture_lsn();
`;

serial(
  "routing.auto",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events);
      try {
        const seen: string[] = [];
        for (let index = 0; index < 6; index += 1) {
          await db.notes.find({ limit: 1 });
          const event = events.at(-1);
          expect(event?.op).toBe("read");
          expect(event?.reason.startsWith("auto:")).toBe(true);
          expect(event?.endpoint === "a" || event?.endpoint === "b").toBe(true);
          if (event !== undefined) seen.push(event.endpoint);
        }
        expect(seen.includes("a")).toBe(true);
        expect(seen.includes("b")).toBe(true);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

serial(
  "routing.classes",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events);
      try {
        const live: string[] = [];
        let n = 0;
        const rng = mulberry32(64);
        for (let step = 0; step < 16; step += 1) {
          const kind = live.length === 0 ? 0 : Math.floor(rng() * 5);
          if (kind === 0) {
            const id = `c${String(n)}`;
            n += 1;
            await expectPrimary(events, async () => {
              await db.notes.insert({ id, title: id });
            });
            live.push(id);
          } else if (kind === 1) {
            const id = live[0];
            if (id === undefined) continue;
            await expectPrimary(events, async () => {
              await db.notes.update({ where: { id }, set: { title: `${id}u` } });
            });
          } else if (kind === 2) {
            const id = live.pop();
            if (id === undefined) continue;
            await expectPrimary(events, async () => {
              await db.notes.delete({ where: { id } });
            });
          } else if (kind === 3) {
            const id = `c${String(n)}`;
            n += 1;
            await expectPrimary(events, async () => {
              await db.batch([db.notes.insert({ id, title: id })]);
            });
            live.push(id);
          } else {
            const id = `c${String(n)}`;
            n += 1;
            const nested = `c${String(n)}`;
            n += 1;
            const batched = `c${String(n)}`;
            n += 1;
            await expectPrimary(events, async () => {
              await db.tx(async (tx) => {
                await tx.notes.insert({ id, title: id });
                await tx.tx(async (inner) => {
                  await inner.notes.insert({ id: nested, title: nested });
                });
                await tx.notes.find({ limit: 1, lock: "share" });
                await tx.advisoryLock(id);
                await tx.batch([tx.notes.insert({ id: batched, title: batched })]);
              });
            });
            live.push(id, nested, batched);
          }
        }
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

serial(
  "routing.classes: select nextval is a read",
  async () => {
    const ddl = `
      drop table {{schema}}.notes;
      create sequence {{schema}}.okm_seq;
      create view {{schema}}.notes as
        select nextval('{{schema}}.okm_seq')::text as id, 'held'::text as title;
    `;
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events);
      try {
        let caught: unknown;
        try {
          await db.notes.find({ limit: 1 });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        const event = events.at(-1);
        expect(event?.op).toBe("read");
        expect(event?.endpoint === "a" || event?.endpoint === "b").toBe(true);
        expect(event?.reason.startsWith("auto:")).toBe(true);
        expect(errorText(caught).toLowerCase()).toContain("read-only");
      } finally {
        await db.close();
      }
    }, ddl);
  },
  30_000,
);

serial(
  "routing.strict",
  async () => {
    await withSchema(async (admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        routing: { fallback: "error", probe: 200 },
      });
      try {
        await pauseWalReplay("a");
        await pauseWalReplay("b");
        await db.notes.insert({ id: "s1", title: "strict" });
        const mark = await readInsertLsn(admin);
        events.length = 0;
        await expectCode(() => db.notes.find({ limit: 1, route: "replica" }), "OKM1843");
        expect(events.some((event) => event.endpoint === "primary")).toBe(false);
        const scoped = db.using("replica");
        await scoped.connected;
        events.length = 0;
        await expectCode(() => scoped.notes.find({ limit: 1 }), "OKM1843");
        expect(events.some((event) => event.endpoint === "primary")).toBe(false);
        events.length = 0;
        await expectCode(() => db.notes.find({ limit: 1 }), "OKM1844");
        expect(events.some((event) => event.endpoint === "primary")).toBe(false);
        await resumeWalReplay("a");
        await resumeWalReplay("b");
        await waitForReplayLsn("a", mark);
        await waitForReplayLsn("b", mark);

        await setReplicaContainer("a", false);
        await setReplicaContainer("b", false);
        await poll(async () => circuits(db, "open"), 20_000);
        events.length = 0;
        await expectCode(() => db.notes.find({ limit: 1, route: "replica" }), "OKM1843");
        expect(events.some((event) => event.endpoint === "primary")).toBe(false);
        await expectCode(() => db.using("replica").notes.find({ limit: 1 }), "OKM1843");
        events.length = 0;
        await expectCode(() => db.notes.find({ limit: 1 }), "OKM1844");
        expect(events.some((event) => event.endpoint === "primary")).toBe(false);
      } finally {
        await db.close().catch(() => undefined);
        await setReplicaContainer("a", true).catch(() => undefined);
        await setReplicaContainer("b", true).catch(() => undefined);
        await resumeWalReplay("a").catch(() => undefined);
        await resumeWalReplay("b").catch(() => undefined);
      }
    });
  },
  90_000,
);

serial(
  "pool.separation",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        max: 1,
        timeouts: { acquire: 400 },
        routing: { consistency: "eventual", probe: 1_000 },
        replicaMax: 4,
      });
      try {
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let inserted = false;
        const held = db.tx(async (tx) => {
          await tx.notes.insert({ id: "hold", title: "held" });
          inserted = true;
          await gate;
        });
        await poll(async () => inserted);
        events.length = 0;
        const read = await Promise.race([
          db.notes.find({ limit: 1 }).then(() => "replica" as const),
          pause(2_000).then(() => "blocked" as const),
        ]);
        expect(read).toBe("replica");
        const served = events.filter((event) => event.op === "read").at(-1);
        expect(served?.endpoint === "a" || served?.endpoint === "b").toBe(true);
        await expectCode(() => db.tx(async () => undefined), "OKM1846");
        expect(events.some((event) => event.op === "tx" && event.endpoint !== "primary")).toBe(
          false,
        );
        release();
        await held;
        await db.tx(async (tx) => {
          await tx.notes.insert({ id: "after", title: "released" });
        });
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

test("pool.separation: PGlite reserve", async () => {
  const events: RouteEvent[] = [];
  const caughtUp: ReplicaState = { replayLsn: () => "0/1" };
  const db = await connectTopology(
    {
      primary: memory("primary"),
      replicas: [{ url: memory("east"), name: "east" }],
    },
    {
      schema: app,
      routing: { probe: 60_000, consistency: "eventual" },
      replicaState: caughtUp,
      timeouts: { acquire: 300 },
      onRoute(event) {
        events.push(event);
      },
    },
    async (config) => {
      const pool = await openPglite({ dataDir: config.dataDir, timeouts: { acquire: 300 } });
      const stored = Reflect.get(app, "catalog");
      if (typeof stored !== "object" || stored === null) throw new Error("schema has no catalog");
      for (const statement of renderCatalog(stored as Catalog, "public")) {
        await pool.execute(statement);
      }
      return pool;
    },
  );
  try {
    await db.connected;
    events.length = 0;
    let release = (): void => undefined;
    const heldGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = false;
    const held = db.tx(async (tx) => {
      await tx.notes.insert({ id: "hold", title: "held" });
      inserted = true;
      await heldGate;
    });
    await poll(async () => inserted);
    events.length = 0;
    await db.notes.find({ limit: 1 });
    expect(events.at(-1)?.endpoint).toBe("east");
    await expectCode(() => db.tx(async () => undefined), "OKM1846");
    release();
    await held;
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: "after", title: "released" });
    });
  } finally {
    await db.close();
  }
});

serial(
  "tx.affinity",
  async () => {
    await withSchema(async (admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events);
      try {
        const rng = mulberry32(7);
        for (let step = 0; step < 8; step += 1) {
          const id = `t${String(step)}`;
          const nested = `t${String(step)}s`;
          const batched = `t${String(step)}b`;
          const drop = rng() < 0.5;
          events.length = 0;
          await db.tx(async (tx) => {
            await tx.notes.insert({ id, title: id });
            try {
              await tx.tx(async (inner) => {
                await inner.notes.insert({ id: nested, title: nested });
                if (drop) throw new Error("drop-savepoint");
              });
            } catch (error) {
              if (!drop || !(error instanceof Error) || error.message !== "drop-savepoint") {
                throw error;
              }
            }
            const seen = await tx.notes.find({ where: { id }, limit: 1 });
            expect(countOf(seen)).toBe(1);
            const nestedRows = await tx.notes.find({ where: { id: nested }, limit: 1 });
            expect(countOf(nestedRows)).toBe(drop ? 0 : 1);
            await tx.notes.find({ limit: 1, lock: "update" });
            await tx.advisoryLock(`affinity-${id}`);
            await tx.batch([tx.notes.insert({ id: batched, title: batched })]);
          });
          for (const event of events) expect(event.endpoint).toBe("primary");
          const rows = await admin.unsafe<{ pid: number; recovering: boolean }[]>(
            `select pid, recovering from ${schemaName}.note_audit where id in ('${id}', '${batched}')`,
          );
          expect(rows.length).toBeGreaterThan(0);
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("audit row has no backend pid");
          expect(pid).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.pid).toBe(pid);
            expect(row.recovering).toBe(false);
          }
        }
      } finally {
        await db.close();
      }
    }, AUDIT);
  },
  60_000,
);

serial(
  "consistency.position",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const db = await openDb(schemaName, [], { routing: { probe: 250 } });
      try {
        let latest = "";
        const paused = new Set<ReplicaName>();
        const rng = mulberry32(20_261_007);
        let violations = 0;
        for (let step = 0; step < 24; step += 1) {
          const roll = Math.floor(rng() * 4);
          if (roll === 0 || latest === "") {
            latest = `w${String(step)}`;
            await db.notes.insert({ id: latest, title: latest });
          } else if (roll === 1) {
            const name: ReplicaName = rng() < 0.5 ? "a" : "b";
            if (!paused.has(name)) {
              await pauseWalReplay(name);
              paused.add(name);
            }
          } else if (roll === 2) {
            const name = paused.values().next().value;
            if (name !== undefined) {
              await resumeWalReplay(name);
              paused.delete(name);
            }
          } else {
            const rows = await db.notes.find({ where: { id: latest }, limit: 1 });
            if (titleOf(rows) !== latest) violations += 1;
          }
        }
        expect(violations).toBe(0);
      } finally {
        await db.close();
        await resumeWalReplay("a").catch(() => undefined);
        await resumeWalReplay("b").catch(() => undefined);
      }
    });
  },
  90_000,
);

serial(
  "consistency.position: commit lsn is past the in-transaction wal lsn",
  async () => {
    await withSchema(async (admin, schemaName) => {
      await assertPositions(admin, schemaName, "on");
    }, AUDIT);
    const name = `okm_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = openPostgres();
    try {
      await admin.unsafe(`create database ${name}`);
      await admin.unsafe(`alter database ${name} set synchronous_commit = off`);
      const created = await readInsertLsn(admin);
      await waitForReplayLsn("a", created);
      await waitForReplayLsn("b", created);
      const dbAdmin = openPostgres(databaseUrl(primaryUrl(), name));
      try {
        const shown = await dbAdmin<
          { mode: string }[]
        >`select current_setting('synchronous_commit') as mode`;
        expect(shown[0]?.mode).toBe("off");
        const schemaName = isolatedSchemaName();
        await dbAdmin.unsafe(`create schema ${schemaName}`);
        await dbAdmin.unsafe(`create table ${schemaName}.notes (id text primary key, title text)`);
        await dbAdmin.unsafe(AUDIT.replaceAll("{{schema}}", schemaName));
        const ready = await readInsertLsn(dbAdmin);
        await waitForReplayLsn("a", ready);
        await waitForReplayLsn("b", ready);
        await assertPositions(dbAdmin, schemaName, "off", databaseUrl(primaryUrl(), name));
        await dbAdmin.unsafe(`drop schema if exists ${schemaName} cascade`);
      } finally {
        await dbAdmin.end({ timeout: 5 });
      }
    } finally {
      await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  },
  90_000,
);

serial(
  "consistency.position: replay cache is a lower bound",
  async () => {
    await withSchema(async (admin, schemaName) => {
      const db = await openDb(schemaName, [], { routing: { probe: 200 } });
      try {
        await db.notes.insert({ id: "cache", title: "cache" });
        const mark = await readInsertLsn(admin);
        await waitForReplayLsn("a", mark);
        await pauseWalReplay("a");
        const frozen = await readReplayLsn("a");
        await db.notes.insert({ id: "ahead", title: "ahead" });
        const ahead = await readInsertLsn(admin);
        expect(compareLsn(frozen, ahead)).toBeLessThan(0);
        const during = await readReplayLsn("a");
        expect(during).toBe(frozen);
        let previous: string | null = null;
        await resumeWalReplay("a");
        await poll(async () => {
          const cached = replayOf(db, "a");
          if (cached !== null && previous !== null) {
            expect(compareLsn(cached, previous)).toBeGreaterThanOrEqual(0);
          }
          if (cached !== null) previous = cached;
          const live = await readReplayLsn("a");
          expect(compareLsn(live, frozen)).toBeGreaterThanOrEqual(0);
          return compareLsn(live, ahead) >= 0 && cached !== null && compareLsn(cached, ahead) >= 0;
        }, 20_000);
      } finally {
        await db.close();
        await resumeWalReplay("a").catch(() => undefined);
      }
    });
  },
  45_000,
);

serial(
  "consistency.position: a stale replica is not used",
  async () => {
    const role = `r_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = openPostgres();
    const schemaName = isolatedSchemaName();
    try {
      await admin.unsafe(`create schema ${schemaName}`);
      await admin.unsafe(`create table ${schemaName}.notes (id text primary key, title text)`);
      await admin.unsafe(
        `create role ${role} login password 'okm' nosuperuser nocreatedb nocreaterole`,
      );
      await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
      );
      const ready = await readInsertLsn(admin);
      await waitForReplayLsn("a", ready);
      await waitForReplayLsn("b", ready);

      const events: RouteEvent[] = [];
      const granted = await openDb(schemaName, events, {
        primary: roleUrl(primaryUrl(), role),
        replicaA: roleUrl(replicaUrl("a"), role),
        replicaB: roleUrl(replicaUrl("b"), role),
        routing: { probe: 60_000 },
      });
      try {
        await revokeWal(admin);
        await pauseWalReplay("a");
        await pauseWalReplay("b");
        events.length = 0;
        await granted.notes.insert({ id: "stale", title: "stale" });
        events.length = 0;
        const rows = await granted.notes.find({ where: { id: "stale" }, limit: 1 });
        expect(titleOf(rows)).toBe("stale");
        expect(events.at(-1)?.endpoint).toBe("primary");
        expect(events.at(-1)?.reason).toBe("fallback:position-unknown");
        expect(events.some((event) => event.endpoint === "a" || event.endpoint === "b")).toBe(
          false,
        );
        await expectCode(() => granted.notes.find({ limit: 1, route: "replica" }), "OKM1843");
        await expectCode(() => granted.using("replica").notes.find({ limit: 1 }), "OKM1843");
      } finally {
        await granted.close().catch(() => undefined);
        await grantWal(admin);
        await resumeWalReplay("a").catch(() => undefined);
        await resumeWalReplay("b").catch(() => undefined);
      }

      await grantWal(admin);
      events.length = 0;
      await revokeWal(admin);
      // The revoke is a catalog change that replicas replay later. Wait for
      // both to replay it, or the probe can still see the grant and read a
      // position the test is not about (flaky on 15; see P69).
      const revoked = await readInsertLsn(admin);
      await waitForReplayLsn("a", revoked);
      await waitForReplayLsn("b", revoked);
      const blind = await openDb(schemaName, events, {
        primary: roleUrl(primaryUrl(), role),
        replicaA: roleUrl(replicaUrl("a"), role),
        replicaB: roleUrl(replicaUrl("b"), role),
        routing: { probe: 60_000 },
      });
      try {
        const view = readTopology(blind);
        expect(view?.endpoints.every((endpoint) => endpoint.position === false)).toBe(true);
        await pauseWalReplay("a");
        events.length = 0;
        await blind.notes.insert({ id: "blind", title: "blind" });
        events.length = 0;
        const rows = await blind.notes.find({ where: { id: "blind" }, limit: 1 });
        expect(titleOf(rows)).toBe("blind");
        expect(events.at(-1)?.reason).toBe("fallback:position-unknown");
        expect(events.at(-1)?.endpoint).toBe("primary");
        await expectCode(() => blind.notes.find({ limit: 1, route: "replica" }), "OKM1843");
      } finally {
        await blind.close().catch(() => undefined);
        await grantWal(admin);
        await resumeWalReplay("a").catch(() => undefined);
      }
    } finally {
      await grantWal(admin);
      await admin.unsafe(`drop schema if exists ${schemaName} cascade`).catch(() => undefined);
      await admin.unsafe(`drop owned by ${role}`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  },
  60_000,
);

serial(
  "consistency.position: idle primary lag is zero",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        routing: { maxLag: "500ms", probe: 200 },
      });
      try {
        await db.notes.insert({ id: "idle", title: "idle" });
        await poll(async () => {
          events.length = 0;
          await db.notes.find({ limit: 1 });
          const event = events.at(-1);
          return event?.reason.startsWith("auto:") === true;
        });
        const since = Date.now();
        await poll(async () => Date.now() - since >= 800, 5_000);
        events.length = 0;
        const rows = await db.notes.find({ where: { id: "idle" }, limit: 1 });
        expect(titleOf(rows)).toBe("idle");
        const event = events.at(-1);
        expect(event?.endpoint === "a" || event?.endpoint === "b").toBe(true);
        expect(event?.reason.startsWith("auto:")).toBe(true);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

serial(
  "consistency.position: measurements",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const sessionEvents: RouteEvent[] = [];
      const session = await openDb(schemaName, sessionEvents, { routing: { probe: 1_000 } });
      const eventual = await openDb(schemaName, [], {
        routing: { consistency: "eventual", probe: 60_000 },
      });
      try {
        for (let index = 0; index < 3; index += 1) {
          await session.notes.insert({ id: `warm-s${String(index)}`, title: "w" });
          await eventual.notes.insert({ id: `warm-e${String(index)}`, title: "w" });
        }
        const sessionMs = await timeInserts(session, "s", 40);
        const eventualMs = await timeInserts(eventual, "e", 40);
        const sessionP50 = percentile(sessionMs, 50);
        const sessionP95 = percentile(sessionMs, 95);
        const eventualP50 = percentile(eventualMs, 50);
        const eventualP95 = percentile(eventualMs, 95);
        console.log(
          `measurement position-cost session-p50=${sessionP50.toFixed(2)} session-p95=${sessionP95.toFixed(2)} eventual-p50=${eventualP50.toFixed(2)} eventual-p95=${eventualP95.toFixed(2)} extra-p50=${(sessionP50 - eventualP50).toFixed(2)} extra-p95=${(sessionP95 - eventualP95).toFixed(2)}`,
        );

        let reads = 0;
        let fallbacks = 0;
        let autos = 0;
        await session.close();
        const measured = await openMeasured(schemaName, (event) => {
          if (event.op !== "read") return;
          reads += 1;
          if (event.reason.startsWith("fallback:")) fallbacks += 1;
          if (event.reason.startsWith("auto:")) autos += 1;
        });
        try {
          let stop = false;
          const readers = [0, 1].map(async () => {
            while (!stop) await measured.notes.find({ limit: 1 });
          });
          const started = performance.now();
          for (let index = 0; index < 20; index += 1) {
            await measured.notes.insert({ id: `load${String(index)}`, title: "load" });
          }
          const elapsed = performance.now() - started;
          stop = true;
          await Promise.all(readers);
          const rate = reads === 0 ? 0 : fallbacks / reads;
          console.log(
            `measurement fallback-rate writers=1 writes=20 elapsed-ms=${elapsed.toFixed(0)} reads=${String(reads)} fallbacks=${String(fallbacks)} rate=${rate.toFixed(3)} replica-reads=${String(autos)} lag=replaying-not-paused`,
          );
          reads = 0;
          fallbacks = 0;
          autos = 0;
          for (let round = 0; round < 8; round += 1) {
            await measured.notes.insert({ id: `mix${String(round)}`, title: "mix" });
            for (let read = 0; read < 8; read += 1) await measured.notes.find({ limit: 1 });
          }
          const share = reads === 0 ? 0 : autos / reads;
          console.log(
            `measurement replica-share writers=1 writes=8 reads-per-write=8 reads=${String(reads)} replica-reads=${String(autos)} share=${share.toFixed(3)} fallbacks=${String(fallbacks)}`,
          );
        } finally {
          await measured.close();
        }
      } finally {
        await session.close().catch(() => undefined);
        await eventual.close();
      }
    });
  },
  90_000,
);

serial(
  "selection.weighted",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, { weights: { a: 1, b: 3 } });
      try {
        for (let index = 0; index < 40; index += 1) await db.notes.find({ limit: 1 });
        const counts = tally(events);
        expect(counts.primary).toBe(0);
        expect(Math.abs(counts.a - 10)).toBeLessThanOrEqual(2);
        expect(Math.abs(counts.b - 30)).toBeLessThanOrEqual(2);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

serial(
  "selection.weighted-return",
  async () => {
    await withSchema(async (admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        weights: { a: 5, b: 1 },
        routing: { probe: 200 },
      });
      try {
        for (let index = 0; index < 3; index += 1) await db.notes.find({ limit: 1 });
        expect(events.map((event) => event.endpoint).join("")).toBe("aaa");
        await pauseWalReplay("b");
        await db.notes.insert({ id: "burst", title: "burst" });
        const mark = await readInsertLsn(admin);
        await waitForReplayLsn("a", mark);
        events.length = 0;
        await poll(async () => {
          await db.notes.find({ limit: 1 });
          return events.at(-1)?.endpoint === "a";
        });
        await resumeWalReplay("b");
        await waitForReplayLsn("b", mark);
        await poll(async () => {
          const cached = replayOf(db, "b");
          return cached !== null && compareLsn(cached, mark) >= 0;
        });
        events.length = 0;
        for (let index = 0; index < 24; index += 1) await db.notes.find({ limit: 1 });
        const sequence = events.map((event) => event.endpoint).join("");
        console.log(`measurement weighted-return ${sequence}`);
        expect(events[0]?.endpoint).toBe("a");
        expect(sequence.includes("b")).toBe(true);
        expect(sequence.includes("bb")).toBe(false);
        const counts = tally(events);
        expect(counts.b).toBeLessThanOrEqual(6);
      } finally {
        await db.close();
        await resumeWalReplay("b").catch(() => undefined);
      }
    });
  },
  45_000,
);

serial(
  "selection.leastConnections",
  async () => {
    const ddl = `
      drop table {{schema}}.notes;
      create function {{schema}}.okm_pause() returns text language plpgsql as $$
      begin
        perform pg_sleep(0.4);
        return 'x';
      end $$;
      create view {{schema}}.notes as
        select '1'::text as id, {{schema}}.okm_pause() as title;
    `;
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        routing: { select: "leastConnections", consistency: "eventual", probe: 60_000 },
      });
      try {
        const first = db.notes.find({ limit: 1 });
        void first.catch(() => undefined);
        await poll(async () => events.length >= 1);
        expect(events[0]?.endpoint).toBe("a");
        const second = db.notes.find({ limit: 1 });
        void second.catch(() => undefined);
        await poll(async () => events.length >= 2);
        expect(events[1]?.endpoint).toBe("b");
        await Promise.all([first, second]);
      } finally {
        await db.close();
      }
    }, ddl);
  },
  30_000,
);

serial(
  "selection.latencyAware",
  async () => {
    const proxy = await startDelayProxy(replicaUrl("b"), 80);
    try {
      await withSchema(async (_admin, schemaName) => {
        const events: RouteEvent[] = [];
        const db = await openDb(schemaName, events, {
          replicaB: proxy.url,
          routing: { select: "latencyAware", consistency: "eventual", probe: 200 },
        });
        try {
          for (let index = 0; index < 12; index += 1) await db.notes.find({ limit: 1 });
          const counts = tally(events);
          expect(counts.a).toBeGreaterThanOrEqual(10);
          expect(counts.primary).toBe(0);
        } finally {
          await db.close();
        }
      });
    } finally {
      await proxy.close();
    }
  },
  30_000,
);

serial(
  "selection.maxLag",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const bytes: RouteEvent[] = [];
      const byteDb = await openDb(schemaName, bytes, {
        routing: { consistency: "eventual", maxLag: "4096B", probe: 200 },
      });
      try {
        await pauseWalReplay("b");
        const payload = Buffer.from(crypto.getRandomValues(new Uint8Array(12_000))).toString(
          "base64",
        );
        await byteDb.notes.insert({ id: "lag", title: payload });
        await poll(async () => {
          bytes.length = 0;
          for (let index = 0; index < 6; index += 1) await byteDb.notes.find({ limit: 1 });
          return bytes.length === 6 && bytes.every((event) => event.endpoint === "a");
        }, 15_000);
      } finally {
        await byteDb.close();
        await resumeWalReplay("b").catch(() => undefined);
      }

      const times: RouteEvent[] = [];
      const timeDb = await openDb(schemaName, times, {
        routing: { consistency: "eventual", maxLag: "500ms", probe: 200 },
      });
      try {
        await pauseWalReplay("b");
        const wrote = Date.now();
        await timeDb.notes.insert({ id: "time", title: "time" });
        await poll(async () => Date.now() - wrote >= 800, 5_000);
        await poll(async () => {
          times.length = 0;
          for (let index = 0; index < 4; index += 1) await timeDb.notes.find({ limit: 1 });
          return times.length === 4 && times.every((event) => event.endpoint === "a");
        }, 15_000);
      } finally {
        await timeDb.close();
        await resumeWalReplay("b").catch(() => undefined);
      }
    });
  },
  45_000,
);

serial(
  "selection.health",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        routing: { consistency: "eventual", probe: 200 },
      });
      try {
        await setReplicaContainer("a", false);
        await poll(async () => circuitOf(db, "a") === "open", 20_000);
        events.length = 0;
        for (let index = 0; index < 6; index += 1) await db.notes.find({ limit: 1 });
        expect(events.every((event) => event.endpoint !== "a")).toBe(true);
        expect(events.some((event) => event.endpoint === "b")).toBe(true);
        await setReplicaContainer("a", true);
        await poll(async () => circuitOf(db, "a") === "closed", 45_000);
        events.length = 0;
        await poll(async () => {
          await db.notes.find({ limit: 1 });
          return events.some((event) => event.endpoint === "a");
        }, 15_000);
      } finally {
        await db.close().catch(() => undefined);
        await setReplicaContainer("a", true).catch(() => undefined);
      }
    });
  },
  90_000,
);

serial(
  "selection.failure",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const db = await openDb(schemaName, [], {
        routing: { consistency: "eventual", probe: 200 },
      });
      try {
        let stop = false;
        let failures = 0;
        let completed = 0;
        const loop = (async () => {
          while (!stop) {
            try {
              await db.notes.find({ limit: 1 });
              completed += 1;
            } catch {
              failures += 1;
            }
          }
        })();
        await poll(async () => completed >= 4);
        const beforeStop = completed;
        await setReplicaContainer("a", false);
        await poll(async () => completed >= beforeStop + 4, 15_000);
        stop = true;
        await loop;
        expect(failures).toBe(0);
      } finally {
        await db.close().catch(() => undefined);
        await setReplicaContainer("a", true).catch(() => undefined);
      }
    });
  },
  60_000,
);

serial(
  "selection.custom",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events, {
        routing: {
          consistency: "eventual",
          select(candidates: readonly ReplicaCandidate[]) {
            const found = candidates.find((candidate) => candidate.name === "b");
            if (found !== undefined) return found;
            const first = candidates[0];
            return first ?? "b";
          },
        },
      });
      try {
        for (let index = 0; index < 8; index += 1) await db.notes.find({ limit: 1 });
        expect(events.every((event) => event.endpoint === "b" && event.reason === "auto:b")).toBe(
          true,
        );
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

serial(
  "selection.primary-fallback",
  async () => {
    await withSchema(async (_admin, schemaName) => {
      const events: RouteEvent[] = [];
      const db = await openDb(schemaName, events);
      try {
        await pauseWalReplay("a");
        await pauseWalReplay("b");
        await db.notes.insert({ id: "fb", title: "fallback" });
        events.length = 0;
        const rows = await db.notes.find({ where: { id: "fb" }, limit: 1 });
        expect(titleOf(rows)).toBe("fallback");
        expect(events.at(-1)).toEqual({
          op: "read",
          endpoint: "primary",
          reason: "fallback:behind",
        });
      } finally {
        await db.close();
        await resumeWalReplay("a").catch(() => undefined);
        await resumeWalReplay("b").catch(() => undefined);
      }
    });
  },
  30_000,
);

function serial(name: string, fn: () => Promise<void>, timeoutMs: number): void {
  if (gate.run) {
    test.serial(name, () => withReplicationLock(fn), { timeout: timeoutMs });
    return;
  }
  if (gate.fail) {
    const message = gate.message;
    test.serial(name, () => {
      throw new Error(message);
    });
    return;
  }
  test.skip(name, fn);
}

type OpenOptions = {
  readonly routing?: {
    readonly probe?: number;
    readonly select?:
      | "weighted"
      | "roundRobin"
      | "leastConnections"
      | "latencyAware"
      | ((
          candidates: readonly ReplicaCandidate[],
          ctx: { readonly op: "read" },
        ) => ReplicaCandidate | string);
    readonly consistency?: "session" | "eventual";
    readonly fallback?: "primary" | "error";
    readonly maxLag?: string;
  };
  readonly max?: number;
  readonly timeouts?: { readonly acquire: number };
  readonly weights?: { readonly a?: number; readonly b?: number };
  readonly replicaMax?: number;
  readonly primary?: string;
  readonly replicaA?: string;
  readonly replicaB?: string;
};

async function openDb(schemaName: string, events: RouteEvent[], options: OpenOptions = {}) {
  const weightA = options.weights?.a ?? 1;
  const weightB = options.weights?.b ?? 1;
  const replicaPool = options.replicaMax === undefined ? {} : { pool: { max: options.replicaMax } };
  const db = await connect(
    {
      primary: options.primary ?? primaryUrl(),
      replicas: [
        {
          url: options.replicaA ?? replicaUrl("a"),
          name: "a",
          weight: weightA,
          ...replicaPool,
        },
        {
          url: options.replicaB ?? replicaUrl("b"),
          name: "b",
          weight: weightB,
          ...replicaPool,
        },
      ],
    },
    {
      schema: app,
      searchPath: schemaName,
      max: options.max ?? 4,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      routing: options.routing ?? { probe: 1_000 },
      onRoute(event) {
        events.push(event);
      },
    },
  );
  await db.connected;
  events.length = 0;
  return db;
}

async function openMeasured(schemaName: string, onRoute: (event: RouteEvent) => void) {
  const db = await connect(
    {
      primary: primaryUrl(),
      replicas: [
        { url: replicaUrl("a"), name: "a" },
        { url: replicaUrl("b"), name: "b" },
      ],
    },
    {
      schema: app,
      searchPath: schemaName,
      max: 4,
      routing: { probe: 250 },
      onRoute,
    },
  );
  await db.connected;
  return db;
}

async function withSchema<T>(
  fn: (admin: Sql, schemaName: string) => Promise<T>,
  ddl?: string,
): Promise<T> {
  await resumeWalReplay("a").catch(() => undefined);
  await resumeWalReplay("b").catch(() => undefined);
  const admin = openPostgres();
  const schemaName = isolatedSchemaName();
  try {
    await admin.unsafe(`create schema ${schemaName}`);
    await admin.unsafe(`create table ${schemaName}.notes (id text primary key, title text)`);
    if (ddl !== undefined) await admin.unsafe(ddl.replaceAll("{{schema}}", schemaName));
    const lsn = await readInsertLsn(admin);
    await waitForReplayLsn("a", lsn);
    await waitForReplayLsn("b", lsn);
    return await fn(admin, schemaName);
  } finally {
    await resumeWalReplay("a").catch(() => undefined);
    await resumeWalReplay("b").catch(() => undefined);
    await admin.unsafe(`drop schema if exists ${schemaName} cascade`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
}

async function assertPositions(
  admin: Sql,
  schemaName: string,
  mode: "on" | "off",
  primary: string = primaryUrl(),
): Promise<void> {
  const db = await connect(
    {
      primary,
      replicas: [
        { url: databaseUrl(replicaUrl("a"), databaseOf(primary)), name: "a" },
        { url: databaseUrl(replicaUrl("b"), databaseOf(primary)), name: "b" },
      ],
    },
    { schema: app, searchPath: schemaName, max: 4, routing: { probe: 1_000 } },
  );
  try {
    await db.connected;
    await checkWrite(admin, schemaName, mode, "single", async () => {
      await db.notes.insert({ id: `${mode}-one`, title: "one" });
    });
    await checkWrite(admin, schemaName, mode, "several", async () => {
      await db.notes.insert({ id: `${mode}-a`, title: "a" });
      await db.notes.insert({ id: `${mode}-b`, title: "b" });
      await db.notes.insert({ id: `${mode}-c`, title: "c" });
    });
    await checkWrite(admin, schemaName, mode, "tx", async () => {
      await db.tx(async (tx) => {
        await tx.notes.insert({ id: `${mode}-tx1`, title: "tx" });
        await tx.notes.insert({ id: `${mode}-tx2`, title: "tx" });
      });
    });
    await checkWrite(admin, schemaName, mode, "batch", async () => {
      await db.batch([
        db.notes.insert({ id: `${mode}-batch1`, title: "batch" }),
        db.notes.insert({ id: `${mode}-batch2`, title: "batch" }),
      ]);
    });
  } finally {
    await db.close();
  }
}

async function checkWrite(
  admin: Sql,
  schemaName: string,
  mode: "on" | "off",
  label: string,
  write: () => Promise<void>,
): Promise<void> {
  await admin.unsafe(`delete from ${schemaName}.note_audit`);
  await write();
  const after = await admin<
    { insert_lsn: string; wal_lsn: string }[]
  >`select pg_current_wal_insert_lsn()::text as insert_lsn, pg_current_wal_lsn()::text as wal_lsn`;
  const postInsert = after[0]?.insert_lsn;
  const postWal = after[0]?.wal_lsn;
  if (postInsert === undefined || postWal === undefined) throw new Error("missing lsn");
  const rows = await admin.unsafe<{ insert_lsn: string; wal_lsn: string }[]>(
    `select insert_lsn, wal_lsn from ${schemaName}.note_audit`,
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(compareLsn(postInsert, row.insert_lsn)).toBeGreaterThan(0);
    expect(compareLsn(postInsert, row.wal_lsn)).toBeGreaterThan(0);
    if (mode === "on") expect(compareLsn(postWal, row.insert_lsn)).toBeGreaterThanOrEqual(0);
  }
  console.log(
    `measurement commit-lsn mode=${mode} shape=${label} post-insert=${postInsert} post-wal=${postWal} wal-behind=${String(compareLsn(postWal, postInsert) < 0)}`,
  );
}

async function expectPrimary(events: RouteEvent[], run: () => Promise<void>): Promise<void> {
  const start = events.length;
  await run();
  const slice = events.slice(start);
  expect(slice.length).toBeGreaterThan(0);
  for (const event of slice) expect(event.endpoint).toBe("primary");
}

async function expectCode(run: () => unknown, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function timeInserts(
  db: Awaited<ReturnType<typeof openDb>>,
  prefix: string,
  count: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await db.notes.insert({ id: `${prefix}${String(index)}`, title: "t" });
    samples.push(performance.now() - started);
  }
  return samples;
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function tally(events: readonly RouteEvent[]): { a: number; b: number; primary: number } {
  const counts = { a: 0, b: 0, primary: 0 };
  for (const event of events) {
    if (event.op !== "read") continue;
    if (event.endpoint === "a") counts.a += 1;
    else if (event.endpoint === "b") counts.b += 1;
    else if (event.endpoint === "primary") counts.primary += 1;
  }
  return counts;
}

function circuits(client: object, state: "open" | "closed"): boolean {
  const view = readTopology(client);
  if (view === undefined) return false;
  return view.endpoints
    .filter((endpoint) => endpoint.role === "replica")
    .every((endpoint) => endpoint.circuit === state);
}

function circuitOf(client: object, name: string): "open" | "closed" | undefined {
  return readTopology(client)?.endpoints.find((endpoint) => endpoint.name === name)?.circuit;
}

function replayOf(client: object, name: string): string | null {
  return (
    readTopology(client)?.endpoints.find((endpoint) => endpoint.name === name)?.replayLsn ?? null
  );
}

function titleOf(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const row = value[0];
  if (typeof row !== "object" || row === null) return null;
  const title = Reflect.get(row, "title");
  return typeof title === "string" ? title : null;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const extra = cause instanceof Error ? cause.message : "";
  return `${error.message} ${extra}`;
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseOf(base: string): string {
  const name = new URL(base).pathname.replace(/^\//, "");
  return name.length === 0 ? "okm" : name;
}

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = "okm";
  return url.toString();
}

async function revokeWal(admin: Sql): Promise<void> {
  await admin.unsafe(
    "revoke execute on function pg_catalog.pg_current_wal_insert_lsn() from public",
  );
  await admin.unsafe("revoke execute on function pg_catalog.pg_last_wal_replay_lsn() from public");
}

async function grantWal(admin: Sql): Promise<void> {
  await admin
    .unsafe("grant execute on function pg_catalog.pg_current_wal_insert_lsn() to public")
    .catch(() => undefined);
  await admin
    .unsafe("grant execute on function pg_catalog.pg_last_wal_replay_lsn() to public")
    .catch(() => undefined);
}

function memory(label: string): string {
  return `memory://${label}-${crypto.randomUUID()}`;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function poll(ready: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await ready()) return;
      await pause(50);
    }
    throw new Error("condition was not met");
  })();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
