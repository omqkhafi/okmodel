/**
 * Routing on the streaming topology: one primary and two hot standbys.
 */

import { expect } from "bun:test";

import {
  isolatedSchemaName,
  pauseWalReplay,
  primaryUrl,
  readInsertLsn,
  replicaUrl,
  resumeWalReplay,
  waitForReplayLsn,
} from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { connectTopology, type TopologyClient, type TopologyOptions } from "./client.js";
import { TopologyError } from "./error.js";
import type { StatementEvent } from "./pool.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

function options(patch: Partial<TopologyOptions> = {}): TopologyOptions {
  return {
    primary: primaryUrl(),
    replicas: [
      { url: replicaUrl("a"), name: "a", weight: 1 },
      { url: replicaUrl("b"), name: "b", weight: 1 },
    ],
    routing: { select: "roundRobin", consistency: "session", fallback: "primary", probe: "0ms" },
    timeouts: { acquire: 1000 },
    ...patch,
  };
}

async function withClient(
  patch: Partial<TopologyOptions>,
  fn: (client: TopologyClient, log: StatementEvent[]) => Promise<void>,
): Promise<void> {
  const log: StatementEvent[] = [];
  const client = await connectTopology({
    ...options(patch),
    onStatement: (event) => {
      log.push(event);
    },
  });
  try {
    await fn(client, log);
  } finally {
    await client.close();
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function saw(log: readonly StatementEvent[], token: string, endpoint: string): boolean {
  return log.some((event) => event.endpoint === endpoint && event.text.includes(token));
}

postgresTest(decision, "routing.auto and routing.classes", async () => {
  await withClient({}, async (client, log) => {
    const token = "p08a-auto";
    const read = await client
      .read(
        `SELECT pg_is_in_recovery()::text, COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '') /*${token}*/`,
      )
      .run();
    expect(read.decision.role).toBe("replica");
    expect(read.decision.reason).toBe(`auto:${read.decision.endpoint}`);
    expect(read.results[0]?.rows[0]?.[0]).toBe("true");
    expect(read.results[0]?.rows[0]?.[1]).toBe(`replica_${read.decision.endpoint}`);
    expect(saw(log, token, "primary")).toBe(false);

    const write = await client.write(
      `SELECT pg_is_in_recovery()::text, COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '') /*${token}-w*/`,
    );
    expect(write.decision).toEqual({
      endpoint: "primary",
      role: "primary",
      reason: "primary-required",
    });
    expect(write.results[0]?.rows[0]?.[0]).toBe("false");
    expect(write.results[0]?.rows[0]?.[1]).toBe("");
    expect(saw(log, `${token}-w`, "a")).toBe(false);
    expect(saw(log, `${token}-w`, "b")).toBe(false);
  });
});

postgresTest(
  decision,
  "routing.strict: .primary() and .replica() do not fall through",
  async () => {
    await withClient({}, async (client, log) => {
      const primary = await client
        .read("SELECT pg_is_in_recovery()::text /*p08a-pri*/")
        .primary()
        .run();
      expect(primary.decision.reason).toBe("constraint:primary");
      expect(primary.results[0]?.rows[0]?.[0]).toBe("false");

      client.noteCommit("FFFFFFFF/FFFFFFFF");
      const token = "p08a-strict";
      const strict = await rejection(client.read(`SELECT 1 /*${token}*/`).replica().run());
      expect(strict).toBeInstanceOf(TopologyError);
      if (strict instanceof TopologyError) {
        expect(strict.code).toBe("OKM1843");
        expect(strict.fix).toContain("Configure a replica");
      }
      expect(saw(log, token, "primary")).toBe(false);
      expect(saw(log, token, "a")).toBe(false);
      expect(saw(log, token, "b")).toBe(false);

      const fallback = await client.read("SELECT pg_is_in_recovery()::text /*p08a-fb*/").run();
      expect(fallback.decision.reason).toBe("fallback:behind");
      expect(fallback.results[0]?.rows[0]?.[0]).toBe("false");

      const primaryRequired = await rejection(
        client.run({
          kind: "write",
          statements: [{ text: "SELECT 1" }],
          constraint: { kind: "replica" },
        }),
      );
      expect(primaryRequired).toMatchObject({ code: "OKM1840" });
    });
  },
);

postgresTest(decision, "no replicas: reads use the primary and .replica() is OKM1843", async () => {
  await withClient({ replicas: [] }, async (client) => {
    const read = await client.read("SELECT pg_is_in_recovery()::text").run();
    expect(read.decision.reason).toBe("fallback:no-replicas");
    expect(read.results[0]?.rows[0]?.[0]).toBe("false");
    expect(await rejection(client.read("SELECT 1").replica().run())).toMatchObject({
      code: "OKM1843",
    });
  });
});

postgresTest(decision, "internal read-only transactions run on a replica", async () => {
  await withClient({}, async (client) => {
    const read = await client
      .internalRead([
        "SELECT set_config('okm.p08a', 'yes', true)",
        "SELECT current_setting('okm.p08a'), pg_is_in_recovery()::text, pg_backend_pid()::text",
        "SELECT pg_backend_pid()::text",
      ])
      .run();
    expect(read.decision.role).toBe("replica");
    expect(read.results[1]?.rows[0]?.[0]).toBe("yes");
    expect(read.results[1]?.rows[0]?.[1]).toBe("true");
    expect(read.results[1]?.rows[0]?.[2]).toBe(read.results[2]?.rows[0]?.[0]);
  });
});

postgresTest(decision, "routing.once: every statement of a read uses one endpoint", async () => {
  await withClient({}, async (client, log) => {
    const token = "p08a-once";
    const read = await client
      .readMany([
        `SELECT pg_backend_pid()::text /*${token}*/`,
        `SELECT pg_backend_pid()::text /*${token}*/`,
      ])
      .run();
    expect(read.decision.role).toBe("replica");
    expect(read.results[0]?.rows[0]?.[0]).toBe(read.results[1]?.rows[0]?.[0]);
    const endpoints = new Set(
      log.filter((event) => event.text.includes(token)).map((event) => event.endpoint),
    );
    expect([...endpoints]).toEqual([read.decision.endpoint]);
  });
});

postgresTest(
  decision,
  "health filtering skips a replica that does not answer",
  async () => {
    await withClient(
      {
        replicas: [
          { url: replicaUrl("a"), name: "a" },
          { url: "postgres://okm:okm@127.0.0.1:1/okm", name: "dead" },
        ],
      },
      async (client, log) => {
        const token = "p08a-health";
        const read = await client.read(`SELECT 1 /*${token}*/`).run();
        expect(read.decision.endpoint).toBe("a");
        expect(saw(log, token, "dead")).toBe(false);
      },
    );
  },
  30_000,
);

postgresTest(decision, "selection strategies land on the replica they name", async () => {
  await withClient({ routing: { select: "roundRobin", probe: "0ms" } }, async (client) => {
    const names: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const read = await client
        .read("SELECT COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '')")
        .run();
      names.push(read.decision.endpoint);
      expect(read.results[0]?.rows[0]?.[0]).toBe(`replica_${read.decision.endpoint}`);
    }
    expect(names).toEqual(["a", "b", "a", "b"]);
  });

  await withClient(
    {
      replicas: [
        { url: replicaUrl("a"), name: "a", weight: 2 },
        { url: replicaUrl("b"), name: "b", weight: 1 },
      ],
      routing: { select: "weighted", probe: "0ms" },
    },
    async (client) => {
      const names: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const read = await client.read("SELECT 1").run();
        names.push(read.decision.endpoint);
      }
      expect(names).toEqual(["a", "b", "a", "a", "b", "a"]);
    },
  );

  let flip = 0;
  await withClient(
    {
      routing: { select: "random", probe: "0ms" },
      random: () => (flip++ % 2 === 0 ? 0 : 0.99),
    },
    async (client) => {
      const first = await client.read("SELECT 1").run();
      const second = await client.read("SELECT 1").run();
      expect([first.decision.endpoint, second.decision.endpoint]).toEqual(["a", "b"]);
    },
  );

  await withClient(
    {
      replicas: [
        { url: replicaUrl("a"), name: "a", pool: { max: 2 } },
        { url: replicaUrl("b"), name: "b", pool: { max: 2 } },
      ],
      routing: { select: "leastConnections", probe: "0ms" },
    },
    async (client) => {
      const held = await client.acquire("a");
      try {
        const read = await client.read("SELECT 1").run();
        expect(read.decision.endpoint).toBe("b");
      } finally {
        held.release();
      }
    },
  );

  await withClient(
    {
      routing: {
        select: (candidates) => candidates.find((item) => item.name === "b")?.name ?? "a",
        probe: "0ms",
      },
    },
    async (client) => {
      const read = await client
        .read("SELECT COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '')")
        .run();
      expect(read.decision.endpoint).toBe("b");
      expect(read.results[0]?.rows[0]?.[0]).toBe("replica_b");
    },
  );
});

postgresTest(decision, "lag eligibility and fallback", async () => {
  const schema = isolatedSchemaName();
  await withClient(
    { routing: { select: "roundRobin", maxLag: "1B", probe: "0ms" } },
    async (client) => {
      try {
        await client.write(`CREATE SCHEMA ${schema}`);
        await client.write(`CREATE TABLE ${schema}.tick (id int)`);
        const caught = await readInsertLsn();
        await waitForReplayLsn("a", caught);
        await waitForReplayLsn("b", caught);
        await pauseWalReplay("a");
        await client.write(`INSERT INTO ${schema}.tick VALUES (1)`);
        const target = await readInsertLsn();
        await waitForReplayLsn("b", target);
        await client.probe();
        for (let index = 0; index < 4; index += 1) {
          const read = await client
            .read("SELECT COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '')")
            .run();
          expect(read.decision.endpoint).toBe("b");
          expect(read.results[0]?.rows[0]?.[0]).toBe("replica_b");
        }
      } finally {
        await resumeWalReplay("a");
        await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      }
    },
  );
});

postgresTest(decision, "fallback:error is OKM1844 and does not read the primary", async () => {
  await withClient(
    { routing: { fallback: "error", probe: "0ms", select: "roundRobin" } },
    async (client, log) => {
      client.noteCommit("FFFFFFFF/FFFFFFFF");
      const token = "p08a-err";
      expect(await rejection(client.read(`SELECT 1 /*${token}*/`).run())).toMatchObject({
        code: "OKM1844",
      });
      expect(saw(log, token, "primary")).toBe(false);
    },
  );
});

postgresTest(
  decision,
  "sessions keep separate watermarks and unscoped shares the root",
  async () => {
    await withClient({}, async (client) => {
      const ahead = "FFFFFFFF/FFFFFFFF";
      client.for("writer").noteCommit(ahead);
      const writer = await client.for("writer").read("SELECT pg_is_in_recovery()::text").run();
      expect(writer.decision.reason).toBe("fallback:behind");
      const other = await client.for("reader").read("SELECT pg_is_in_recovery()::text").run();
      expect(other.decision.role).toBe("replica");
      client.noteCommit(ahead);
      const root = await client.unscoped().read("SELECT pg_is_in_recovery()::text").run();
      expect(root.decision.role).toBe("primary");
      expect(client.for("reader").watermark()).toBeNull();
    });
  },
);

postgresTest(
  decision,
  "position-unknown reads use the primary; eventual .replica() does not",
  async () => {
    await withClient({}, async (client) => {
      client.markPositionUnknown();
      const read = await client.read("SELECT pg_is_in_recovery()::text").run();
      expect(read.decision.reason).toBe("fallback:position-unknown");
      expect(read.results[0]?.rows[0]?.[0]).toBe("false");
      expect(await rejection(client.read("SELECT 1").replica().run())).toMatchObject({
        code: "OKM1843",
      });
      const eventual = await client
        .read("SELECT pg_is_in_recovery()::text")
        .replica({ consistency: "eventual" })
        .run();
      expect(eventual.decision.role).toBe("replica");
      expect(eventual.results[0]?.rows[0]?.[0]).toBe("true");
    });
  },
);
