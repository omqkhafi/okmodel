/**
 * Per-endpoint pools on the streaming topology.
 *
 * Checkout is a separate step from routing. A full pool fails with OKM1846
 * and does not take a connection from another endpoint.
 */

import { expect } from "bun:test";

import { primaryUrl, replicaUrl } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { connectTopology, type TopologyOptions } from "./client.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

function options(patch: Partial<TopologyOptions> = {}): TopologyOptions {
  return {
    primary: { url: primaryUrl(), pool: { max: 2 } },
    replicas: [
      { url: replicaUrl("a"), name: "a", pool: { max: 1 } },
      { url: replicaUrl("b"), name: "b", pool: { max: 1 } },
    ],
    routing: { select: "roundRobin", probe: "0ms", fallback: "primary" },
    timeouts: { acquire: 1000 },
    ...patch,
  };
}

const IDENTITY =
  "SELECT pg_backend_pid()::text, pg_is_in_recovery()::text, COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '')";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

postgresTest(
  decision,
  "pool.separation: endpoint choice and connection choice are separate",
  async () => {
    const client = await connectTopology(options());
    try {
      const read = await client.read("SELECT 1").run();
      expect(read.decision.role).toBe("replica");
      expect("pid" in read.decision).toBe(false);

      const primary = await client.acquire("primary");
      const replica = await client.acquire("a");
      try {
        const primaryRow = await primary.execute(IDENTITY);
        const replicaRow = await replica.execute(IDENTITY);
        expect(primaryRow.rows[0]?.[1]).toBe("false");
        expect(primaryRow.rows[0]?.[2]).toBe("");
        expect(replicaRow.rows[0]?.[1]).toBe("true");
        expect(replicaRow.rows[0]?.[2]).toBe("replica_a");
        expect(primaryRow.rows[0]?.[0]).not.toBe(replicaRow.rows[0]?.[0]);
        expect(client.stats("b").inflight).toBe(0);
      } finally {
        primary.release();
        replica.release();
      }
    } finally {
      await client.close();
    }
  },
);

postgresTest(decision, "tx.affinity: one transaction keeps one primary connection", async () => {
  const client = await connectTopology(options());
  try {
    const result = await client.tx(async (connection) => {
      const first = await connection.execute(IDENTITY);
      await connection.execute("SAVEPOINT affinity");
      const batched = await connection.batch([{ text: "SELECT pg_backend_pid()::text" }]);
      await connection.execute("RELEASE SAVEPOINT affinity");
      const second = await connection.execute("SELECT pg_backend_pid()::text");
      return {
        pid: first.rows[0]?.[0] ?? "",
        recovery: first.rows[0]?.[1] ?? "",
        slot: first.rows[0]?.[2] ?? "",
        batchPid: batched[0]?.rows[0]?.[0] ?? "",
        laterPid: second.rows[0]?.[0] ?? "",
      };
    });
    expect(result.decision).toEqual({
      endpoint: "primary",
      role: "primary",
      reason: "primary-required",
    });
    expect(result.recovery).toBe("false");
    expect(result.slot).toBe("");
    expect(result.pid).not.toBe("");
    expect(result.value.pid).toBe(result.pid);
    expect(result.value.batchPid).toBe(result.pid);
    expect(result.value.laterPid).toBe(result.pid);

    const again = await client.tx(async (connection) => {
      const row = await connection.execute("SELECT pg_backend_pid()::text");
      return row.rows[0]?.[0] ?? "";
    });
    expect(again.value).not.toBe("");
  } finally {
    await client.close();
  }
});

postgresTest(decision, "pool exhaustion is per endpoint and does not spill", async () => {
  const client = await connectTopology(options({ timeouts: { acquire: 40 } }));
  try {
    const held = await client.acquire("a", 1000);
    try {
      expect(client.stats("b").inflight).toBe(0);
      const timeout = await rejection(client.acquire("a", 40));
      expect(timeout).toMatchObject({
        code: "OKM1846",
        kind: "timeout",
        category: "transient",
      });
      expect(client.stats("b").inflight).toBe(0);
      const other = await client.acquire("b", 1000);
      const row = await other.execute(IDENTITY);
      expect(row.rows[0]?.[2]).toBe("replica_b");
      other.release();
      const still = await held.execute("SELECT pg_backend_pid()::text");
      expect(still.rows[0]?.[0]).not.toBe("");
    } finally {
      held.release();
    }

    const first = await client.acquire("a", 1000);
    const second = await client.acquire("b", 1000);
    try {
      const read = await client.read("SELECT pg_is_in_recovery()::text").run();
      expect(read.decision.reason).toBe("fallback:saturated");
      expect(read.results[0]?.rows[0]?.[0]).toBe("false");
    } finally {
      first.release();
      second.release();
    }
  } finally {
    await client.close();
  }
});
