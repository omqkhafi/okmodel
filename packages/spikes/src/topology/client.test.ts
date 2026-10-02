/**
 * Client routing with scripted pools.
 *
 * These cover re-route and the "does not reach" log. The Docker tests cover
 * the same decisions on the streaming topology.
 */

import { expect, test } from "bun:test";

import type { DriverPool, ExecuteResult, Statement } from "../drivers/types.js";
import { connectTopology, type TopologyClient } from "./client.js";
import { TopologyError } from "./error.js";

function result(rows: (string | null)[][]): ExecuteResult {
  return { rows, columns: [], count: rows.length, notices: [] };
}

function scripted(fail: (text: string) => boolean): DriverPool {
  const execute = (text: string): Promise<ExecuteResult> => {
    if (text.includes("pg_current_wal_insert_lsn") || text.includes("pg_last_wal_replay_lsn")) {
      return Promise.resolve(result([["0/10", null]]));
    }
    if (fail(text)) {
      return Promise.reject(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );
    }
    return Promise.resolve(result([["ok"]]));
  };
  const pool: DriverPool = {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "none",
      describe: false,
    },
    preparedModes: ["none"],
    execute,
    async batch(statements: readonly Statement[]) {
      const rows: ExecuteResult[] = [];
      for (const statement of statements) rows.push(await execute(statement.text));
      return rows;
    },
    async reserve() {
      return {
        execute,
        batch: (statements) => pool.batch(statements),
        release() {},
      };
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    takeStatements: () => 0,
    serverVersion: () => Promise.resolve("stub"),
    close: () => Promise.resolve(),
  };
  return pool;
}

test("a transport failure re-routes once and .replica() does not use the primary", async () => {
  const log: string[] = [];
  const pools = new Map<string, DriverPool>([
    ["primary", scripted(() => false)],
    ["bad", scripted((text) => text.includes("TOKEN"))],
    ["good", scripted(() => false)],
  ]);
  const client = await connectTopology({
    primary: "postgres://primary",
    replicas: [
      { url: "postgres://bad", name: "bad" },
      { url: "postgres://good", name: "good" },
    ],
    routing: { select: "roundRobin", probe: "0ms" },
    open: (url) => {
      const pool = pools.get(url.slice("postgres://".length));
      if (pool === undefined) throw new Error(url);
      return pool;
    },
    onStatement: (event) => {
      if (event.text.includes("TOKEN")) log.push(`${event.endpoint}:${event.text}`);
    },
  });
  try {
    const routed = await client.read("SELECT 1 /*TOKEN*/").run();
    expect(routed.decision.endpoint).toBe("good");
    expect(routed.decision.role).toBe("replica");
    expect(log.some((line) => line.startsWith("bad:"))).toBe(true);
    expect(log.some((line) => line.startsWith("good:"))).toBe(true);
    expect(log.some((line) => line.startsWith("primary:"))).toBe(false);

    log.length = 0;
    const strict = await connectStrict(pools, log);
    const error = await rejection(strict.read("SELECT 1 /*TOKEN*/").replica().run());
    expect(error).toBeInstanceOf(TopologyError);
    expect(log.some((line) => line.startsWith("primary:"))).toBe(false);
    await strict.close();
  } finally {
    await client.close();
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

async function connectStrict(
  pools: ReadonlyMap<string, DriverPool>,
  log: string[],
): Promise<TopologyClient> {
  return connectTopology({
    primary: "postgres://primary",
    replicas: [{ url: "postgres://bad", name: "bad" }],
    routing: { select: "roundRobin", probe: "0ms", fallback: "primary" },
    open: (url) => {
      const pool = pools.get(url.slice("postgres://".length));
      if (pool === undefined) throw new Error(url);
      return pool;
    },
    onStatement: (event) => {
      if (event.text.includes("TOKEN")) log.push(`${event.endpoint}:${event.text}`);
    },
  });
}
