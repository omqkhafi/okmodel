/**
 * A dead replica is left out of connect, and a read falls back to the primary
 * when its one retry also fails (real Postgres 17 standbys).
 *
 * `bun run db:up`, then `bun test tests/replica-failover-pg.test.ts`.
 * Stops use `pg_ctl -m immediate`, the same order as the audit. The cluster
 * lock keeps that from overlapping other replica tests.
 */

import { expect, test } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";

import { OkmError } from "../src/contracts/error.js";
import { fragment, raw, schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectNeon } from "../src/runtime/pg/neon.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";
import { readTopology, type RouteEvent } from "../src/runtime/topology.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { openPostgres, postgresReachable } from "../packages/harness/src/postgres.js";
import {
  loadPostgresGate,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";
import {
  readInsertLsn,
  setReplicaContainer,
  waitForReplayLsn,
  withReplicationLock,
} from "../packages/harness/src/replication.js";
import { primaryUrl, replicaUrl, type ReplicaName } from "../packages/harness/src/topology.js";

const rows = table("fo_notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [rows] });

const REFUSED = "postgres://okm:okm@127.0.0.1:1/okm";

const gate = await loadPostgresGate();
requirePostgresWhenAsked(gate);

type Db = {
  fo_notes: {
    find(query: { limit: number; route?: "replica" }): Promise<readonly { title: string | null }[]>;
    insert(row: { id: string; title: string }): Promise<unknown>;
  };
  connected: Promise<unknown>;
  close(): Promise<void>;
};

type DriverName = "postgresjs" | "pg" | "bun";

const neonSaved = {
  fetchEndpoint: neonConfig.fetchEndpoint,
  wsProxy: neonConfig.wsProxy,
  useSecureWebSocket: neonConfig.useSecureWebSocket,
  forceDisablePgSSL: neonConfig.forceDisablePgSSL,
  pipelineConnect: neonConfig.pipelineConnect,
  pipelineTLS: neonConfig.pipelineTLS,
};

class Cell {
  ok = "";
}

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

function restoreNeon(): void {
  neonConfig.fetchEndpoint = neonSaved.fetchEndpoint;
  neonConfig.wsProxy = neonSaved.wsProxy;
  neonConfig.useSecureWebSocket = neonSaved.useSecureWebSocket;
  neonConfig.forceDisablePgSSL = neonSaved.forceDisablePgSSL;
  neonConfig.pipelineConnect = neonSaved.pipelineConnect;
  neonConfig.pipelineTLS = neonSaved.pipelineTLS;
}

async function ensureReplicas(): Promise<void> {
  for (const replica of ["a", "b"] as const) {
    if (await postgresReachable(replicaUrl(replica))) continue;
    await setReplicaContainer(replica, true).catch(() => undefined);
    if (await postgresReachable(replicaUrl(replica))) continue;
    await setReplicaContainer(replica, true);
  }
}

async function stopImmediate(replica: ReplicaName): Promise<void> {
  const container = replica === "a" ? "okmodel-replica-a-1" : "okmodel-replica-b-1";
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-u",
      "postgres",
      container,
      "pg_ctl",
      "stop",
      "-m",
      "immediate",
      "-D",
      "/var/lib/postgresql/data",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  await new Response(proc.stderr).text();
  await proc.exited;
  const url = replicaUrl(replica);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await postgresReachable(url))) return;
    await Bun.sleep(50);
  }
  throw new Error(`replica ${replica} did not stop`);
}

async function seed(): Promise<{ drop(): Promise<void> }> {
  await ensureReplicas();
  const admin = openPostgres();
  await admin.unsafe(
    "create table if not exists fo_notes (id text primary key, title text); insert into fo_notes values ('seed', 'first') on conflict do nothing",
  );
  const lsn = await readInsertLsn(admin);
  await waitForReplayLsn("a", lsn);
  await waitForReplayLsn("b", lsn);
  return {
    async drop() {
      await admin.unsafe("drop table if exists fo_notes").catch(() => undefined);
      await admin.end({ timeout: 5 });
    },
  };
}

async function poll(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition was not met");
}

function tcp(
  driver: DriverName,
  primary: string,
  replicas: readonly { url: string; name: string }[],
  events: RouteEvent[],
  routing: { probe: number; consistency?: "eventual"; fallback?: "primary" | "error" },
): Promise<Db> {
  const options = {
    schema: app,
    routing,
    onRoute: (event: RouteEvent) => events.push(event),
  };
  const target = { primary, replicas };
  if (driver === "postgresjs") return connectPostgresJs(target, options) as unknown as Promise<Db>;
  if (driver === "pg") return connectPg(target, options) as unknown as Promise<Db>;
  return connectBun(target, options) as unknown as Promise<Db>;
}

async function leaveOut(label: string, open: (events: RouteEvent[]) => Promise<Db>): Promise<void> {
  const table = await seed();
  try {
    await setReplicaContainer("a", false);
    const events: RouteEvent[] = [];
    const db = await open(events);
    try {
      await db.connected;
      const down = readTopology(db)?.endpoints.find((endpoint) => endpoint.name === "a");
      expect(down?.circuit).toBe("open");
      events.length = 0;
      for (let index = 0; index < 24; index += 1) {
        const found = await db.fo_notes.find({ limit: 1 });
        expect(found[0]?.title).toBe("first");
      }
      const reads = events.filter((event) => event.op === "read");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((event) => event.endpoint !== "a")).toBe(true);
      await db.fo_notes.insert({ id: `${label}-w`, title: "wrote" });
      await setReplicaContainer("a", true);
      await poll(async () => {
        events.length = 0;
        for (let index = 0; index < 6; index += 1) await db.fo_notes.find({ limit: 1 });
        return events.some((event) => event.endpoint === "a");
      }, 30_000);
    } finally {
      await db.close().catch(() => undefined);
    }
  } finally {
    await setReplicaContainer("a", true).catch(() => undefined);
    await table.drop();
  }
}

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  serial(
    `${driver}: an unreachable replica is left out and comes back`,
    () =>
      leaveOut(driver, (events) =>
        tcp(
          driver,
          primaryUrl(),
          [
            { url: replicaUrl("a"), name: "a" },
            { url: replicaUrl("b"), name: "b" },
          ],
          events,
          { probe: 200, consistency: "eventual" },
        ),
      ),
    90_000,
  );
}

serial(
  "neon: an unreachable replica is left out and comes back",
  async () => {
    const local = startPair();
    try {
      for (const mode of ["websocket", "http"] as const) {
        await leaveOut(
          `neon-${mode}`,
          (events) =>
            connectNeon(
              {
                primary: neonHost("primary.local"),
                replicas: [
                  { url: neonHost("replica-a.local"), name: "a" },
                  { url: neonHost("replica-b.local"), name: "b" },
                ],
              },
              {
                schema: app,
                mode,
                routing: { probe: 200, consistency: "eventual" },
                onRoute: (event) => events.push(event),
              },
            ) as unknown as Promise<Db>,
        );
      }
    } finally {
      await local.close();
    }
  },
  180_000,
);

serial(
  "both standbys stopped: twenty reads use the primary, then replicas again",
  async () => {
    const table = await seed();
    const events: RouteEvent[] = [];
    const db = await tcp(
      "postgresjs",
      primaryUrl(),
      [
        { url: replicaUrl("a"), name: "r1" },
        { url: replicaUrl("b"), name: "r2" },
      ],
      events,
      { probe: 200, consistency: "eventual", fallback: "primary" },
    );
    try {
      await db.connected;
      await db.fo_notes.find({ limit: 1 });
      events.length = 0;
      await stopImmediate("a");
      await stopImmediate("b");
      let failed = 0;
      for (let index = 0; index < 20; index += 1) {
        try {
          const found = await db.fo_notes.find({ limit: 1 });
          expect(found[0]?.title).toBe("first");
        } catch {
          failed += 1;
        }
      }
      expect(failed).toBe(0);
      expect(events.some((event) => event.reason === "fallback:unhealthy")).toBe(true);
      await ensureReplicas();
      await poll(async () => {
        events.length = 0;
        for (let index = 0; index < 8; index += 1) await db.fo_notes.find({ limit: 1 });
        return events.some((event) => event.endpoint === "r1" || event.endpoint === "r2");
      }, 30_000);
    } finally {
      await db.close().catch(() => undefined);
      await ensureReplicas().catch(() => undefined);
      await table.drop();
    }
  },
  90_000,
);

serial(
  "a read in flight and a second read both finish when that replica drops",
  async () => {
    const table = await seed();
    const events: RouteEvent[] = [];
    const db = await tcp(
      "postgresjs",
      primaryUrl(),
      [
        { url: replicaUrl("a"), name: "a" },
        { url: replicaUrl("b"), name: "b" },
      ],
      events,
      { probe: 60_000, consistency: "eventual" },
    );
    try {
      await db.connected;
      events.length = 0;
      const sleep = raw(db.fo_notes, Cell, "read", fragment`select pg_sleep(5)::text as ok`);
      await poll(async () => events.some((event) => event.op === "read"), 5_000);
      const killed = events.find((event) => event.op === "read")?.endpoint;
      expect(killed === "a" || killed === "b").toBe(true);
      await stopImmediate(killed === "a" ? "a" : "b");
      const second = db.fo_notes.find({ limit: 1 });
      const settled = await Promise.race([
        Promise.all([sleep, second]).then(() => "done" as const),
        Bun.sleep(20_000).then(() => "hung" as const),
      ]);
      expect(settled).toBe("done");
      const secondRows = await second;
      expect(secondRows[0]?.title).toBe("first");
      const view = readTopology(db);
      for (const endpoint of view?.endpoints ?? []) {
        if (endpoint.role !== "replica") continue;
        expect(endpoint.circuit).toBe(endpoint.failures >= 2 ? "open" : "closed");
      }
      const down = view?.endpoints.find((endpoint) => endpoint.name === killed);
      expect(down?.failures).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close().catch(() => undefined);
      await ensureReplicas().catch(() => undefined);
      await table.drop();
    }
  },
  60_000,
);

serial(
  "a write still fails when the primary is down and a replica is up",
  async () => {
    const table = await seed();
    const db = await tcp("postgresjs", REFUSED, [{ url: replicaUrl("a"), name: "a" }], [], {
      probe: 60_000,
      consistency: "eventual",
    });
    const connected = db.connected.then(
      () => undefined,
      () => undefined,
    );
    try {
      await connected;
      let kind = "";
      try {
        await db.fo_notes.insert({ id: "primary-down", title: "no" });
      } catch (error) {
        kind = error instanceof OkmError ? error.kind : "";
      }
      expect(kind).toBe("unavailable");
    } finally {
      await db.close().catch(() => undefined);
      await table.drop();
    }
  },
  30_000,
);

serial(
  "neon websocket still rejects connect when the primary cannot be opened",
  async () => {
    pointNeonRefused();
    try {
      let rejected = false;
      try {
        await connectNeon(
          { primary: neonHost("primary.local"), replicas: [REFUSED] },
          { schema: app, mode: "websocket", routing: { probe: 60_000 } },
        );
      } catch (error) {
        rejected = error instanceof OkmError;
      }
      expect(rejected).toBe(true);
    } finally {
      restoreNeon();
    }
  },
  20_000,
);

serial(
  "fallback error still throws when no replica can serve",
  async () => {
    const db = await tcp(
      "postgresjs",
      primaryUrl(),
      [
        { url: REFUSED, name: "a" },
        { url: "postgres://okm:okm@127.0.0.1:2/okm", name: "b" },
      ],
      [],
      { probe: 60_000, consistency: "eventual", fallback: "error" },
    );
    try {
      await db.connected;
      let code = "";
      try {
        await db.fo_notes.find({ limit: 1 });
      } catch (error) {
        code = error instanceof OkmError ? error.code : "";
      }
      expect(code).toBe("OKM1844");
      let replica = "";
      try {
        await db.fo_notes.find({ limit: 1, route: "replica" });
      } catch (error) {
        replica = error instanceof OkmError ? error.code : "";
      }
      expect(replica).toBe("OKM1843");
    } finally {
      await db.close().catch(() => undefined);
    }
  },
  30_000,
);

function neonHost(host: string): string {
  return `postgres://okm:okm@${host}/okm`;
}

function pointNeonRefused(): void {
  neonConfig.wsProxy = () => "127.0.0.1:1/v2";
  neonConfig.fetchEndpoint = () => "http://127.0.0.1:1/sql";
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
}

function startPair(): { close(): Promise<void> } {
  const primary = startNeonLocal(primaryUrl());
  const a = startNeonLocal(replicaUrl("a"));
  const b = startNeonLocal(replicaUrl("b"));
  const hosts: Record<string, string> = {
    "primary.local": primary.host,
    "replica-a.local": a.host,
    "replica-b.local": b.host,
  };
  neonConfig.wsProxy = (host: string) => `${hosts[host] ?? "127.0.0.1:1"}/v2`;
  neonConfig.fetchEndpoint = (host: string) => `http://${hosts[host] ?? "127.0.0.1:1"}/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
  return {
    async close() {
      await closeLocal(primary);
      await closeLocal(a);
      await closeLocal(b);
      restoreNeon();
    },
  };
}

async function closeLocal(local: NeonLocal): Promise<void> {
  await local.close().catch(() => undefined);
}
