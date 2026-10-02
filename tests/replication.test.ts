import { expect } from "bun:test";

import { compareLsn } from "../packages/harness/src/lsn.js";
import { openPostgres } from "../packages/harness/src/postgres.js";
import {
  pauseWalReplay,
  readInsertLsn,
  readReplayLsn,
  resumeWalReplay,
  waitForReplayLsn,
} from "../packages/harness/src/replication.js";
import { primaryUrl, replicaUrl, type ReplicaName } from "../packages/harness/src/topology.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "a primary write reaches both replicas, and a paused replica catches up",
  async () => {
    const seen = crypto.randomUUID();
    const held = crypto.randomUUID();
    const primary = openPostgres(primaryUrl());
    try {
      const version = await primary<{ version: string }[]>`select version() as version`;
      console.log(`postgres: ${version[0]?.version ?? ""}`);
      await primary.unsafe(
        "create table if not exists okm_repl_probe (id uuid primary key, note text not null)",
      );

      await primary`insert into okm_repl_probe (id, note) values (${seen}, 'seen')`;
      const seenLsn = await readInsertLsn(primary);
      console.log(`lsn both-replicas: ${seenLsn}`);
      await waitForReplayLsn("a", seenLsn);
      await waitForReplayLsn("b", seenLsn);
      await expectRow("a", seen, true);
      await expectRow("b", seen, true);

      await pauseWalReplay("a");
      const pausedBefore = await readReplayLsn("a");
      console.log(`lsn paused-before: ${pausedBefore}`);

      await primary`insert into okm_repl_probe (id, note) values (${held}, 'held')`;
      const insertLsn = await readInsertLsn(primary);
      console.log(`lsn insert: ${insertLsn}`);
      const pausedDuring = await readReplayLsn("a");
      console.log(`lsn paused-during: ${pausedDuring}`);
      expect(pausedDuring).toBe(pausedBefore);
      expect(compareLsn(pausedDuring, insertLsn)).toBeLessThan(0);
      await expectRow("a", held, false);

      const replicaB = await waitForReplayLsn("b", insertLsn);
      console.log(`lsn replica-b: ${replicaB}`);
      expect(compareLsn(replicaB, insertLsn)).toBeGreaterThanOrEqual(0);
      await expectRow("b", held, true);

      await resumeWalReplay("a");
      const resumed = await waitForReplayLsn("a", insertLsn);
      console.log(`lsn resumed: ${resumed}`);
      expect(compareLsn(resumed, insertLsn)).toBeGreaterThanOrEqual(0);
      await expectRow("a", held, true);
    } finally {
      await resumeWalReplay("a");
      await primary`delete from okm_repl_probe where id in (${seen}, ${held})`;
      await primary.end({ timeout: 5 });
    }
  },
  30_000,
);

async function expectRow(replica: ReplicaName, id: string, present: boolean): Promise<void> {
  const sql = openPostgres(replicaUrl(replica));
  try {
    const rows = await sql<{ id: string }[]>`select id from okm_repl_probe where id = ${id}`;
    expect(rows.length).toBe(present ? 1 : 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
