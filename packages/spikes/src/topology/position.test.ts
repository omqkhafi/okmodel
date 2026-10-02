/**
 * Commit position on the streaming topology.
 *
 * The watermark is `pg_current_wal_insert_lsn()` after commit. `pg_waldump`
 * supplies the commit-record LSN that function does not return.
 */

import { afterAll, expect, test } from "bun:test";

import {
  compareLsn,
  isolatedSchemaName,
  openPostgres,
  pauseWalReplay,
  primaryUrl,
  readInsertLsn,
  readReplayLsn,
  replicaUrl,
  resumeWalReplay,
  waitForReplayLsn,
} from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import type { ExecuteResult } from "../drivers/types.js";
import { connectTopology, type TopologyClient, type TopologyOptions } from "./client.js";
import { TopologyError } from "./error.js";
import type { StatementEvent } from "./pool.js";
import { withReplayLock } from "./replay-lock.js";
import { addLsn, findCommitLsn, lsnGap } from "./waldump.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

afterAll(async () => {
  if (!decision.run) return;
  await resumeWalReplay("a").catch(() => undefined);
  await resumeWalReplay("b").catch(() => undefined);
});

test("LSN arithmetic stays on the byte position", () => {
  expect(addLsn("0/10", 16n)).toBe("0/20");
  expect(lsnGap("0/20", "0/10")).toBe(16n);
});

type CommitSample = {
  readonly label: string;
  readonly sync: "on" | "off";
  readonly inside: string;
  readonly after: string;
  readonly wal: string;
  readonly commit: string;
  readonly recordBytes: number;
  readonly gapBytes: string;
  readonly insideDelta: string;
  readonly afterPastRecord: boolean;
  readonly walPastRecord: boolean;
  readonly insideNotPastCommit: boolean;
};

function cell(result: ExecuteResult, index = 0): string {
  const value = result.rows[0]?.[index];
  if (value === null || value === undefined || value === "") throw new Error("empty cell");
  return value;
}

function options(patch: Partial<TopologyOptions> = {}, log?: StatementEvent[]): TopologyOptions {
  return {
    primary: primaryUrl(),
    replicas: [
      { url: replicaUrl("a"), name: "a" },
      { url: replicaUrl("b"), name: "b" },
    ],
    routing: { select: "roundRobin", consistency: "session", fallback: "primary", probe: "0ms" },
    timeouts: { acquire: 2000 },
    onStatement: log === undefined ? undefined : (event) => log.push(event),
    ...patch,
  };
}

async function withClient(
  patch: Partial<TopologyOptions>,
  fn: (client: TopologyClient, log: StatementEvent[]) => Promise<void>,
): Promise<void> {
  const log: StatementEvent[] = [];
  const client = await connectTopology({
    ...options(patch, log),
    ...patch,
    onStatement: (event) => log.push(event),
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

async function waitFlushed(client: TopologyClient, target: string): Promise<void> {
  const held = await client.acquire("primary");
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const flush = cell(await held.execute("SELECT pg_current_wal_flush_lsn()::text"));
      if (compareLsn(flush, target) >= 0) return;
      if (Date.now() > deadline) throw new Error(`WAL did not flush to ${target}.`);
      await Bun.sleep(20);
    }
  } finally {
    held.release();
  }
}

async function sampleCommit(
  client: TopologyClient,
  label: string,
  sync: "on" | "off",
  statements: readonly string[],
): Promise<CommitSample> {
  const held = await client.acquire("primary");
  let open = true;
  try {
    await held.execute(`SET synchronous_commit TO ${sync}`);
    const before = cell(await held.execute("SELECT pg_current_wal_insert_lsn()::text"));
    await held.execute("BEGIN");
    for (const statement of statements) await held.execute(statement);
    const insideRow = await held.execute(
      "SELECT pg_current_wal_insert_lsn()::text, pg_current_xact_id()::text",
    );
    const inside = cell(insideRow, 0);
    const xid = cell(insideRow, 1);
    await held.execute("COMMIT");
    const afterRow = await held.execute(
      "SELECT pg_current_wal_insert_lsn()::text, pg_current_wal_lsn()::text",
    );
    const after = cell(afterRow, 0);
    const wal = cell(afterRow, 1);
    const directory = cell(await held.execute("SHOW data_directory"));
    await held.execute("RESET synchronous_commit");
    held.release();
    open = false;
    await waitFlushed(client, after);
    const found = await findCommitLsn(xid, before, after, directory);
    const commit = found.lsn;
    const recordBytes = found.recordBytes;
    const gap = lsnGap(after, commit);
    return {
      label,
      sync,
      inside,
      after,
      wal,
      commit,
      recordBytes,
      gapBytes: gap.toString(),
      insideDelta: lsnGap(commit, inside).toString(),
      afterPastRecord: gap >= BigInt(recordBytes),
      walPastRecord: lsnGap(wal, commit) >= BigInt(recordBytes),
      insideNotPastCommit: compareLsn(inside, commit) <= 0,
    };
  } finally {
    if (open) {
      await held.execute("RESET synchronous_commit").catch(() => undefined);
      held.release();
    }
  }
}

function assertSafe(sample: CommitSample): void {
  expect(sample.afterPastRecord).toBe(true);
  expect(sample.insideNotPastCommit).toBe(true);
  expect(BigInt(sample.gapBytes) > 0n).toBe(true);
}

postgresTest(decision, "insert LSN after commit is past the commit record", async () => {
  await withReplayLock(async () => {
    const schema = isolatedSchemaName();
    await withClient({}, async (client) => {
      await client.write(`CREATE SCHEMA ${schema}`);
      await client.write(`CREATE TABLE ${schema}.pos (id int PRIMARY KEY, n int)`);
      const single = await sampleCommit(client, "single", "on", [
        `INSERT INTO ${schema}.pos (id, n) VALUES (1, 1)`,
      ]);
      const several = await sampleCommit(client, "several", "on", [
        `INSERT INTO ${schema}.pos (id, n) VALUES (2, 1)`,
        `INSERT INTO ${schema}.pos (id, n) VALUES (3, 1)`,
        `INSERT INTO ${schema}.pos (id, n) VALUES (4, 1)`,
      ]);
      const asyncCommit = await sampleCommit(client, "sync-off", "off", [
        `INSERT INTO ${schema}.pos (id, n) VALUES (5, 1)`,
      ]);
      const before = await readInsertLsn();
      const batched = await client.batch([
        `INSERT INTO ${schema}.pos (id, n) VALUES (6, 1)`,
        "SELECT pg_current_xact_id()::text",
      ]);
      const xid = batched.results[1]?.rows[0]?.[0];
      const watermark = client.watermark();
      if (xid === null || xid === undefined || watermark === null) {
        throw new Error("batch did not return a transaction id and a watermark");
      }
      const held = await client.acquire("primary");
      let directory = "";
      try {
        directory = cell(await held.execute("SHOW data_directory"));
      } finally {
        held.release();
      }
      await waitFlushed(client, watermark);
      const found = await findCommitLsn(xid, before, watermark, directory);
      const commit = found.lsn;
      const batch = {
        label: "batch",
        watermark,
        commit,
        recordBytes: found.recordBytes,
        gapBytes: lsnGap(watermark, commit).toString(),
        watermarkPastRecord: lsnGap(watermark, commit) >= BigInt(found.recordBytes),
      };
      assertSafe(single);
      assertSafe(several);
      assertSafe(asyncCommit);
      expect(batch.watermarkPastRecord).toBe(true);
      let walBehind = 0;
      const syncOffGaps: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const sample = await sampleCommit(client, `sync-off-${String(index)}`, "off", [
          `INSERT INTO ${schema}.pos (id, n) VALUES (${String(100 + index)}, 1)`,
        ]);
        assertSafe(sample);
        syncOffGaps.push(sample.gapBytes);
        if (!sample.walPastRecord) walBehind += 1;
      }
      await pauseWalReplay("a");
      const replayPaused = await readReplayLsn("a");
      const window = await sampleCommit(client, "window", "on", [
        `INSERT INTO ${schema}.pos (id, n) VALUES (7, 1)`,
      ]);
      const replayStillPaused = await readReplayLsn("a");
      expect(compareLsn(replayStillPaused, window.commit) < 0).toBe(true);
      await resumeWalReplay("a");
      let sawGap = false;
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        const live = await readReplayLsn("a");
        if (compareLsn(live, window.commit) >= 0 && compareLsn(live, window.after) < 0) {
          sawGap = true;
          break;
        }
        if (compareLsn(live, window.after) >= 0) break;
        await Bun.sleep(1);
      }
      console.log(
        JSON.stringify({
          event: "topology-commit",
          single,
          several,
          asyncCommit,
          batch,
          syncOffGaps,
          walBehind,
          replayPaused,
          replayStillPaused,
          window,
          sawGap,
        }),
      );
      await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  });
});

postgresTest(
  decision,
  "read-your-writes holds while replay is paused and after it resumes",
  async () => {
    await withReplayLock(async () => {
      const schema = isolatedSchemaName();
      await withClient({ routing: { select: "roundRobin", probe: "0ms" } }, async (client) => {
        try {
          await client.write(`CREATE SCHEMA ${schema}`);
          await client.write(`CREATE TABLE ${schema}.n (id int PRIMARY KEY, v int)`);
          await client.write(`INSERT INTO ${schema}.n (id, v) VALUES (1, 1)`);
          const caught = await readInsertLsn();
          await waitForReplayLsn("a", caught);
          await waitForReplayLsn("b", caught);
          await pauseWalReplay("a");
          await pauseWalReplay("b");
          await client.write(`UPDATE ${schema}.n SET v = 2 WHERE id = 1`);
          const paused = await readLoop(client, schema, 20);
          expect(paused.violations).toBe(0);
          expect(paused.primary).toBe(20);
          expect(
            await rejection(
              client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).replica().run(),
            ),
          ).toMatchObject({
            code: "OKM1843",
          });
          await resumeWalReplay("b");
          const watermark = client.watermark();
          if (watermark === null) throw new Error("missing watermark");
          await waitForReplayLsn("b", watermark);
          await client.probe();
          const resumed = await readLoop(client, schema, 10);
          expect(resumed.violations).toBe(0);
          expect(resumed.replica).toBe(10);
          expect(resumed.endpoints.every((name) => name === "b")).toBe(true);
          console.log(
            JSON.stringify({
              event: "topology-ryw",
              violations: paused.violations + resumed.violations,
              fallbackPaused: paused.primary / 20,
              fallbackResumed: resumed.primary / 10,
              checksPaused: paused.checks,
              checksResumed: resumed.checks,
            }),
          );
        } finally {
          await resumeWalReplay("a");
          await resumeWalReplay("b");
          await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
        }
      });
    });
  },
);

async function readLoop(
  client: TopologyClient,
  schema: string,
  count: number,
): Promise<{
  violations: number;
  primary: number;
  replica: number;
  checks: number;
  endpoints: string[];
}> {
  let violations = 0;
  let primary = 0;
  let replica = 0;
  let checks = 0;
  const endpoints: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const read = await client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).run();
    if (read.results[0]?.rows[0]?.[0] !== "2") violations += 1;
    if (read.decision.role === "primary") primary += 1;
    if (read.decision.role === "replica") replica += 1;
    checks += read.positionChecks;
    endpoints.push(read.decision.endpoint);
  }
  return { violations, primary, replica, checks, endpoints };
}

postgresTest(decision, "position cost, cache, sessions, and an unknown position", async () => {
  await withReplayLock(async () => {
    const schema = isolatedSchemaName();
    await withClient({}, async (client, log) => {
      await client.write(`CREATE SCHEMA ${schema}`);
      await client.write(`CREATE TABLE ${schema}.n (id int PRIMARY KEY, v int)`);
      await client.write(`INSERT INTO ${schema}.n (id, v) VALUES (1, 1)`);
      const caught = await readInsertLsn();
      await waitForReplayLsn("a", caught);
      await waitForReplayLsn("b", caught);
      const before = log.length;
      await client.write(`UPDATE ${schema}.n SET v = 2 WHERE id = 1`);
      const writeStatements = log
        .slice(before)
        .filter((event) => event.text.includes("pg_current_wal_insert_lsn")).length;
      const coldStarted = performance.now();
      const cold = await client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).run();
      const coldMs = performance.now() - coldStarted;
      const warmStarted = performance.now();
      const warm = await client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).run();
      const warmMs = performance.now() - warmStarted;
      expect(cold.results[0]?.rows[0]?.[0]).toBe("2");
      expect(warm.results[0]?.rows[0]?.[0]).toBe("2");
      expect(writeStatements).toBe(1);
      const firstReplay = client.cachedReplay("a");
      await client.probe();
      const secondReplay = client.cachedReplay("a");
      if (firstReplay !== null && secondReplay !== null) {
        expect(compareLsn(secondReplay, firstReplay) >= 0).toBe(true);
      }
      const rootBefore = client.watermark();
      const session = client.for("tenant");
      await session.write(`UPDATE ${schema}.n SET v = 3 WHERE id = 1`);
      expect(client.watermark()).toBe(rootBefore);
      expect(client.unscoped().watermark()).toBe(rootBefore);
      expect(
        session.watermark() === null ||
          compareLsn(session.watermark() ?? "0/0", rootBefore ?? "0/0") > 0,
      ).toBe(true);
      client.failNextPositionRead();
      await client.write(`UPDATE ${schema}.n SET v = 4 WHERE id = 1`);
      expect(client.positionUnknown()).toBe(true);
      const unknown = await client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).run();
      expect(unknown.decision.reason).toBe("fallback:position-unknown");
      expect(unknown.decision.role).toBe("primary");
      expect(unknown.results[0]?.rows[0]?.[0]).toBe("4");
      await client.write(`UPDATE ${schema}.n SET v = 5 WHERE id = 1`);
      expect(client.positionUnknown()).toBe(false);
      const lag = client.endpointLag("a");
      const age = await replayAge("a");
      console.log(
        JSON.stringify({
          event: "topology-position-cost",
          writePositionStatements: writeStatements,
          coldChecks: cold.positionChecks,
          warmChecks: warm.positionChecks,
          coldMs,
          warmMs,
          idleLagBytes: lag.bytes === null ? null : lag.bytes.toString(),
          idleLagMs: lag.ms,
          replayTimestampAgeMs: age,
        }),
      );
      await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  });
});

postgresTest(
  decision,
  "eventual consistency and a primary-only client skip the position read",
  async () => {
    const schema = isolatedSchemaName();
    const eventual: StatementEvent[] = [];
    const client = await connectTopology(
      options({ routing: { consistency: "eventual", probe: "0ms" } }, eventual),
    );
    try {
      await client.write(`CREATE SCHEMA ${schema}`);
      const before = eventual.length;
      await client.write(`CREATE TABLE ${schema}.n (id int)`);
      expect(
        eventual.slice(before).filter((event) => event.text.includes("pg_current_wal_insert_lsn"))
          .length,
      ).toBe(0);
      await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.close();
    }
    const alone: StatementEvent[] = [];
    const primaryOnly = await connectTopology({
      primary: primaryUrl(),
      replicas: [],
      routing: { probe: "0ms" },
      onStatement: (event) => alone.push(event),
    });
    try {
      const before = alone.length;
      await primaryOnly.write("SELECT 1");
      expect(
        alone.slice(before).filter((event) => event.text.includes("pg_current_wal_insert_lsn"))
          .length,
      ).toBe(0);
    } finally {
      await primaryOnly.close();
    }
  },
);

postgresTest(
  decision,
  "a replica that cannot read positions is not eligible after a write",
  async () => {
    await withReplayLock(async () => {
      const admin = openPostgres(primaryUrl());
      const schema = isolatedSchemaName();
      try {
        await admin.unsafe("DROP ROLE IF EXISTS okm_p08a_nopos");
        await admin.unsafe("CREATE ROLE okm_p08a_nopos LOGIN PASSWORD 'okm' NOSUPERUSER");
        await revokePosition(admin);
        const revoked = await readInsertLsn();
        await waitForReplayLsn("a", revoked);
        await waitForReplayLsn("b", revoked);
        const client = await connectTopology({
          primary: primaryUrl(),
          replicas: [
            { url: roleUrl(replicaUrl("a")), name: "a" },
            { url: roleUrl(replicaUrl("b")), name: "b" },
          ],
          routing: { select: "roundRobin", probe: "0ms" },
        });
        try {
          await client.write(`CREATE SCHEMA ${schema}`);
          await client.write(`CREATE TABLE ${schema}.n (id int PRIMARY KEY, v int)`);
          await client.write(`INSERT INTO ${schema}.n (id, v) VALUES (1, 1)`);
          const read = await client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).run();
          expect(read.decision.reason).toBe("fallback:position-unknown");
          expect(read.decision.role).toBe("primary");
          expect(read.results[0]?.rows[0]?.[0]).toBe("1");
          const strict = await rejection(
            client.read(`SELECT v::text FROM ${schema}.n WHERE id = 1`).replica().run(),
          );
          expect(strict).toBeInstanceOf(TopologyError);
          expect(strict).toMatchObject({ code: "OKM1843" });
        } finally {
          await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
          await client.close();
        }
      } finally {
        await grantPosition(admin);
        await admin.unsafe("DROP ROLE IF EXISTS okm_p08a_nopos").catch(() => undefined);
        await admin.end({ timeout: 5 });
      }
    });
  },
);

postgresTest(
  decision,
  "a caught-up replica reports zero time lag when the replay timestamp is old",
  async () => {
    await withReplayLock(async () => {
      await withClient({}, async (client) => {
        const caught = await readInsertLsn();
        await waitForReplayLsn("a", caught);
        await client.probe();
        const lag = client.endpointLag("a");
        const age = await replayAge("a");
        expect(lag.bytes).toBe(0n);
        expect(lag.ms).toBe(0);
        console.log(
          JSON.stringify({
            event: "topology-idle-lag",
            lagBytes: "0",
            lagMs: 0,
            replayTimestampAgeMs: age,
          }),
        );
      });
    });
  },
);

function roleUrl(url: string): string {
  return url.replace("okm:okm@", "okm_p08a_nopos:okm@");
}

async function revokePosition(admin: ReturnType<typeof openPostgres>): Promise<void> {
  for (const name of POSITION_FNS) {
    await admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${name} FROM PUBLIC`);
  }
}

async function grantPosition(admin: ReturnType<typeof openPostgres>): Promise<void> {
  for (const name of POSITION_FNS) {
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${name} TO PUBLIC`);
  }
}

const POSITION_FNS = [
  "pg_current_wal_insert_lsn()",
  "pg_current_wal_lsn()",
  "pg_last_wal_replay_lsn()",
  "pg_last_xact_replay_timestamp()",
] as const;

async function replayAge(replica: "a" | "b"): Promise<number | null> {
  const sql = openPostgres(replicaUrl(replica));
  try {
    const rows = await sql<{ age: string | null }[]>`
      SELECT EXTRACT(EPOCH FROM (clock_timestamp() - pg_last_xact_replay_timestamp()))::text AS age
    `;
    const age = rows[0]?.age;
    if (age === null || age === undefined || age === "") return null;
    return Number(age) * 1000;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
