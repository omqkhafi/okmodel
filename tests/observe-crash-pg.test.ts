/**
 * A crash yields no event (G-8).
 *
 * A child process writes in a transaction and is killed with SIGKILL, once
 * before COMMIT and once after COMMIT but before the observer is called. The
 * child reports every event it delivers on stdout, so an event the parent
 * never sees was never delivered. The database is the only record: the row is
 * absent in the first case and present in the second. A control run that is
 * not killed shows the events do arrive.
 */

import { afterAll, expect, test } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openRig, runnable, type DriverName, type Rig } from "./observe-conformance-kit.js";

const DDL = "create table notes (id int primary key, body text not null);\n";

const gate = await loadPostgresGate();
const rigs = new Map<DriverName, Promise<Rig>>();

afterAll(async () => {
  for (const pending of rigs.values()) await (await pending).close();
});

type Child = {
  readonly lines: string[];
  waitFor(mark: string): Promise<void>;
  kill(): Promise<string | number | null>;
  finished(): Promise<number>;
};

function spawn(driver: DriverName, url: string, mode: string): Child {
  const proc = Bun.spawn(["bun", "tests/observe-crash.worker.ts", driver, url, mode], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const lines: string[] = [];
  const waiting = new Map<string, () => void>();
  let tail = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      tail += decoder.decode(chunk, { stream: true });
      let at = tail.indexOf("\n");
      while (at >= 0) {
        const line = tail.slice(0, at);
        tail = tail.slice(at + 1);
        lines.push(line);
        waiting.get(line)?.();
        at = tail.indexOf("\n");
      }
    }
  })();
  return {
    lines,
    waitFor(mark) {
      if (lines.includes(mark)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child never said ${mark}`)), 20_000);
        waiting.set(mark, () => {
          clearTimeout(timer);
          resolve();
        });
        void proc.exited.then(() => {
          if (!lines.includes(mark)) reject(new Error(`child exited before ${mark}`));
        });
      });
    },
    async kill() {
      proc.kill("SIGKILL");
      await proc.exited;
      await reading;
      return proc.signalCode;
    },
    async finished() {
      const code = await proc.exited;
      await reading;
      return code;
    },
  };
}

const events = (child: Child): string[] => child.lines.filter((line) => line.startsWith("event "));

async function ids(rig: Rig): Promise<number[]> {
  return (await rig.rows("select id from notes order by id")).map((row) => Number(row.id));
}

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  const title = (name: string): string => `${driver}: ${name}`;
  const rigOf = async (): Promise<Rig> => {
    let pending = rigs.get(driver);
    if (pending === undefined) {
      pending = openRig(driver, DDL);
      rigs.set(driver, pending);
    }
    const rig = await pending;
    await rig.exec("truncate notes");
    return rig;
  };
  if (!runnable(driver)) continue;

  postgresTest(
    gate,
    title("a child that finishes delivers its events (control)"),
    async () => {
      const rig = await rigOf();
      const child = spawn(driver, rig.url as string, "complete");
      expect(await child.finished()).toBe(0);
      const kinds = events(child).map((line) => line.slice(6));
      expect(kinds.some((line) => line.includes('"type":"write"'))).toBe(true);
      expect(kinds.some((line) => line.includes('"outcome":"committed"'))).toBe(true);
      expect(await ids(rig)).toEqual([1]);
    },
    60_000,
  );

  postgresTest(
    gate,
    title("a SIGKILL before COMMIT yields no event and no row"),
    async () => {
      const rig = await rigOf();
      const child = spawn(driver, rig.url as string, "before");
      await child.waitFor("mark written");
      expect(await ids(rig)).toEqual([]);
      expect(await child.kill()).toBe("SIGKILL");
      expect(events(child)).toEqual([]);
      expect(await ids(rig)).toEqual([]);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const open = await rig.rows(
          `select pid from pg_stat_activity where application_name = 'okmodel'
           and datname = current_database() and state like 'idle in transaction%'`,
        );
        if (open.length === 0) break;
        await Bun.sleep(100);
      }
      expect(await ids(rig)).toEqual([]);
    },
    60_000,
  );

  postgresTest(
    gate,
    title("a SIGKILL after COMMIT and before the observer yields no event and a row"),
    async () => {
      const rig = await rigOf();
      const child = spawn(driver, rig.url as string, "after");
      await child.waitFor("mark committed");
      expect(await ids(rig)).toEqual([1]);
      expect(await child.kill()).toBe("SIGKILL");
      expect(events(child)).toEqual([]);
      expect(await ids(rig)).toEqual([1]);
    },
    60_000,
  );
}

test.skip("pglite: a crash yields no event (the database dies with the child, so there is no record to compare)", () => {});
