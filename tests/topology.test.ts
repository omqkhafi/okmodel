/**
 * Topology connect: one pool per endpoint, probes, and a read on the first replica.
 *
 * Pool sizes are recorded by a stand-in `open`. Health uses independent PGlite
 * databases; the replay position comes from `ReplicaState`.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { connectTopology, readTopology, type ReplicaState } from "../src/runtime/topology.js";
import type { TargetInput } from "../src/tooling/migrate/config.js";
import { selectTarget } from "../src/tooling/migrate/policy.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

test("a topology opens one pool per endpoint and reads the first replica", async () => {
  const opened: { url: string; max: number | undefined; sql: string[] }[] = [];
  const db = await connectTopology(
    {
      primary: "postgres://primary/db",
      replicas: [
        { url: "postgres://east/db", weight: 2, name: "east", pool: { max: 4 } },
        "postgres://west/db",
      ],
    },
    { schema: app, max: 8, routing: { probe: 60_000 } },
    (config) => {
      const sql: string[] = [];
      opened.push({ url: config.url, max: config.max, sql });
      return recordingPool(sql);
    },
  );
  await db.connected;
  expect(opened.map((endpoint) => [endpoint.url, endpoint.max])).toEqual([
    ["postgres://primary/db", 8],
    ["postgres://east/db", 4],
    ["postgres://west/db", 8],
  ]);
  const view = readTopology(db);
  expect(view?.endpoints.map((endpoint) => endpoint.name)).toEqual([
    "primary",
    "east",
    "replica-2",
  ]);
  expect(view?.endpoints.map((endpoint) => endpoint.role)).toEqual([
    "primary",
    "replica",
    "replica",
  ]);
  expect(view?.endpoints[1]?.weight).toBe(2);
  expect(view?.endpoints[2]?.weight).toBe(1);
  expect(view?.endpoints.every((endpoint) => endpoint.position)).toBe(true);
  const west = opened[2]?.sql.length ?? 0;
  const rows = await db.notes.find({ limit: 1 });
  expect(rows).toEqual([]);
  expect(opened[0]?.sql.some((text) => text.includes("notes"))).toBe(false);
  expect(opened[1]?.sql.some((text) => text.includes("notes"))).toBe(true);
  expect(opened[2]?.sql.length).toBe(west);
  await db.close();
});

test("a bad topology is OKM1120 and a later routing key is OKM1061", async () => {
  await expectCode(
    () => connectTopology({ replicas: [] }, { schema: app }, () => recordingPool([])),
    "OKM1120",
  );
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db", extra: true } as { primary: string },
        { schema: app },
        () => recordingPool([]),
      ),
    "OKM1120",
  );
  const closed: string[] = [];
  await expectCode(
    () =>
      connectTopology(
        {
          primary: "postgres://primary/db",
          replicas: [{ url: "postgres://east/db", name: "primary" }],
        },
        { schema: app },
        (config) => recordingPool([], () => closed.push(config.url)),
      ),
    "OKM1120",
  );
  expect(closed).toEqual(["postgres://primary/db", "postgres://east/db"]);
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db" },
        { schema: app, routing: { consistency: "session" } },
        () => recordingPool([]),
      ),
    "OKM1061",
  );
});

test("replica probes open a circuit, back off, recover, and stop on close", async () => {
  const probeMs = 40;
  let fail = true;
  let calls = 0;
  const state: ReplicaState = {
    replayLsn() {
      calls += 1;
      if (fail) throw new Error("replica down");
      return "0/16B3748";
    },
  };
  const db = await connect(
    {
      primary: memory("primary"),
      replicas: [{ url: memory("east"), name: "east" }],
    },
    { schema: app, routing: { probe: probeMs }, replicaState: state },
  );
  try {
    await db.connected;
    const started = replicaOf(db);
    expect(started.failures).toBe(1);
    expect(started.circuit).toBe("closed");
    await waitFor(() => replicaOf(db).circuit === "open");
    const open = replicaOf(db);
    expect(open.failures).toBeGreaterThanOrEqual(2);
    expect(open.nextDelayMs).toBe(probeMs * 2);
    fail = false;
    await waitFor(
      () => replicaOf(db).circuit === "closed" && replicaOf(db).replayLsn === "0/16B3748",
    );
    expect(typeof replicaOf(db).position).toBe("boolean");
    const settled = calls;
    await db.close();
    await delay(probeMs * 4);
    expect(calls).toBe(settled);
  } finally {
    await db.close();
  }
});

test("a migrate target that is a replica is OKM1845", () => {
  const config = { schema: "./schema.ts" };
  expect(selectTarget({ ...config, database: "postgres://localhost/app" }, undefined).url).toBe(
    "postgres://localhost/app",
  );
  expect(
    selectTarget(
      { ...config, database: { url: "postgres://localhost/app", protected: true } },
      undefined,
    ).protected,
  ).toBe(true);
  try {
    selectTarget(
      { ...config, database: { url: "postgres://localhost/replica", weight: 2 } as TargetInput },
      undefined,
    );
    throw new Error("replica entry was resolved");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1845");
      expect(error.message).not.toContain("postgres://localhost/replica");
    }
  }
  try {
    selectTarget(
      {
        ...config,
        database: {
          primary: "postgres://localhost/primary",
          replicas: ["postgres://localhost/replica"],
        } as TargetInput,
      },
      undefined,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1845");
      expect(error.message).not.toContain("postgres://localhost/replica");
    }
  }
});

test("a string connect does not load the topology chunk, and a finished script exits", async () => {
  const chunk = Bun.spawn(["bun", "tests/topology-chunk.worker.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [chunkOut, chunkErr, chunkCode] = await Promise.all([
    new Response(chunk.stdout).text(),
    new Response(chunk.stderr).text(),
    chunk.exited,
  ]);
  expect({ code: chunkCode, stdout: chunkOut, stderr: chunkErr }).toEqual({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const exit = Bun.spawn(["bun", "tests/topology-exit.worker.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const outcome = await Promise.race([
    exit.exited.then(async (code) => ({
      hung: false,
      code,
      stdout: await new Response(exit.stdout).text(),
      stderr: await new Response(exit.stderr).text(),
    })),
    delay(2_000).then(() => ({ hung: true, code: -1, stdout: "", stderr: "" })),
  ]);
  if (outcome.hung) exit.kill();
  expect(outcome).toEqual({ hung: false, code: 0, stdout: "", stderr: "" });
});

function recordingPool(sql: string[], onClose?: () => void): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute(text) {
      sql.push(text);
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      if (text.includes("has_function_privilege")) {
        return Promise.resolve({ rows: [["t"]], count: 1, notices: [] });
      }
      if (text.includes("pg_last_wal_replay_lsn")) {
        return Promise.resolve({ rows: [["1", "0/16B3748"]], count: 1, notices: [] });
      }
      return Promise.resolve({ rows: [], count: 0, notices: [] });
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  };
}

function replicaOf(client: object): {
  failures: number;
  circuit: string;
  nextDelayMs: number;
  replayLsn: string | null;
  position: boolean;
} {
  const endpoint = readTopology(client)?.endpoints.find((item) => item.role === "replica");
  if (endpoint === undefined) throw new Error("no replica");
  return endpoint;
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function memory(name: string): string {
  return `memory://okm-topo-${name}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (ready()) return;
    await delay(15);
  }
  throw new Error("timed out waiting for a probe");
}
