/**
 * Live Neon topology.
 *
 * Skips when the credentials are unset, so CI stays green. The first call on
 * each compute is a cold start: a warm-up `select 1` (30s, one retry) is not
 * a test. Times are logged and not asserted. A replica read after a primary
 * write polls for 10s. Labels are primary, r1, and r2.
 */

import { expect, test, beforeAll, afterAll } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";

import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { open } from "../src/adapters/pg/neon.js";
import { connect } from "../src/runtime/pg/neon.js";
import { run } from "../src/tooling/migrate/commands.js";

const LABELS = [
  ["NEON_URL", "primary"],
  ["NEON_POOL_URL", "primary pool"],
  ["NEON_R1_URL", "r1"],
  ["NEON_R1_POOL_URL", "r1 pool"],
  ["NEON_R2_URL", "r2"],
  ["NEON_R2_POOL_URL", "r2 pool"],
] as const;

const absent = LABELS.filter(([key]) => {
  const value = process.env[key];
  return typeof value !== "string" || value.length === 0;
}).map(([, label]) => label);

if (absent.length > 0) {
  test.skip(`neon live skipped, unset: ${absent.join(", ")}`, () => {});
} else {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const notes = table("okm_p107_note", {
    id: t.text().primaryKey(),
    note: t.text(),
  });
  const app = schema({ tables: [notes] });
  const warmMs: Record<string, number> = {};

  beforeAll(async () => {
    for (const [key, label] of LABELS) {
      warmMs[label] = await warm(label, required(key));
    }
    console.info(`neon warm-up ms ${JSON.stringify(warmMs)}`);
    const pool = await open({ url: required("NEON_URL"), mode: "websocket", max: 1 });
    try {
      await pool.execute(
        "create table if not exists okm_p107_note (id text primary key, note text)",
      );
    } finally {
      await pool.close();
    }
  }, 180_000);

  afterAll(async () => {
    const pool = await open({ url: required("NEON_URL"), mode: "websocket", max: 1 });
    try {
      await pool.execute("drop table if exists okm_p107_note");
    } finally {
      await pool.close();
    }
  }, 60_000);

  test("topology routes writes to the primary and reads to a replica", async () => {
    const reasons: { op: string; endpoint: string; reason: string }[] = [];
    const db = await connect(
      {
        primary: required("NEON_URL"),
        replicas: [
          { url: required("NEON_R1_URL"), name: "r1" },
          { url: required("NEON_R2_URL"), name: "r2" },
        ],
      },
      {
        schema: app,
        mode: "websocket",
        onRoute(event) {
          reasons.push({ op: event.op, endpoint: event.endpoint, reason: event.reason });
        },
      },
    );
    try {
      await db.connected;
      const preview = await db.okm_p107_note.find({ limit: 1 }).inspect();
      console.info(`neon automatic read ${preview.routing.endpoint} ${preview.routing.reason}`);
      expect(["primary", "r1", "r2"]).toContain(preview.routing.endpoint);
      reasons.length = 0;
      await db.okm_p107_note.find({ limit: 1, route: "replica" });
      const read = reasons.at(-1);
      expect(read?.op).toBe("read");
      expect(read?.endpoint === "r1" || read?.endpoint === "r2").toBe(true);
      expect(read?.reason).toBe("constraint:replica");
      reasons.length = 0;
      const id = `row-${suffix}`;
      await db.okm_p107_note.insert({ id, note: "wrote" });
      const write = reasons.find((event) => event.op === "write");
      expect(write).toEqual({ op: "write", endpoint: "primary", reason: "primary-required" });
      const seen = await pollReplica(db, id);
      expect(seen).toBe(true);
    } finally {
      await db.close();
    }
  }, 60_000);

  test("http batch is atomic and tx() is refused", async () => {
    const db = await connect(required("NEON_URL"), { schema: app, mode: "http" });
    try {
      await db.connected;
      const refused = await failure(db.tx(async () => undefined));
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1111");
      const id = `http-${suffix}`;
      await db.okm_p107_note.insert({ id, note: "kept" });
      const error = await failure(
        db.batch([
          db.okm_p107_note.insert({ id: `dup-${suffix}`, note: "one" }),
          db.okm_p107_note.insert({ id: `dup-${suffix}`, note: "two" }),
        ]),
      );
      expect(error).toBeInstanceOf(Error);
      const left = await db.okm_p107_note.find({ where: { id: `dup-${suffix}` }, limit: 5 });
      expect(left).toEqual([]);
      const kept = await db.okm_p107_note.find({ where: { id }, limit: 5 });
      expect(kept).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 60_000);

  test("a lost http transaction result is outcome_unknown", async () => {
    const marker = `loss-${suffix}`;
    const previous = neonConfig.fetchFunction;
    neonConfig.fetchFunction = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (bodyText(init?.body).includes(marker)) throw new TypeError("dropped");
      return response;
    };
    const db = await connect(required("NEON_URL"), { schema: app, mode: "http" });
    try {
      await db.connected;
      const error = await failure(
        db.batch([
          db.okm_p107_note.insert({ id: marker, note: "a" }),
          db.okm_p107_note.insert({ id: `${marker}-b`, note: "b" }),
        ]),
      );
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1401");
        expect(error.kind).toBe("outcome_unknown");
      }
    } finally {
      neonConfig.fetchFunction = previous;
      await db.close();
    }
    const check = await connect(required("NEON_URL"), { schema: app, mode: "http" });
    try {
      await check.connected;
      const rows = await check.okm_p107_note.find({ where: { id: marker }, limit: 5 });
      expect(rows).toHaveLength(1);
    } finally {
      await check.close();
    }
  }, 60_000);

  test("websocket commit whose result never arrives is outcome_unknown", async () => {
    const armed = { on: false };
    const previous = neonConfig.webSocketConstructor;
    neonConfig.webSocketConstructor = cuttingSocket(armed);
    const db = await connect(required("NEON_URL"), { schema: app, mode: "websocket", max: 1 });
    const id = `cut-${suffix}`;
    try {
      await db.connected;
      armed.on = true;
      const error = await failure(
        db.tx(async (tx) => {
          await tx.okm_p107_note.insert({ id, note: "cut" });
        }),
      );
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1401");
        expect(error.kind).toBe("outcome_unknown");
        expect(error.retryable).toBe(false);
      }
    } finally {
      neonConfig.webSocketConstructor = previous;
      await db.close();
    }
    const check = await open({ url: required("NEON_URL"), mode: "websocket", max: 1 });
    try {
      const rows = await check.execute("select id from okm_p107_note where id = $1", [id]);
      expect(rows.rows).toEqual([[id]]);
    } finally {
      await check.close();
    }
  }, 60_000);

  test("a direct connection keeps session state", async () => {
    const direct = await open({ url: required("NEON_URL"), mode: "websocket", max: 1 });
    const pooler = await open({ url: required("NEON_POOL_URL"), mode: "websocket", max: 1 });
    const fresh = await open({ url: required("NEON_POOL_URL"), mode: "websocket", max: 1 });
    try {
      await direct.execute("select set_config('okm.p107', 'yes', false)");
      const kept = await direct.execute("select current_setting('okm.p107', true)");
      expect(kept.rows[0]?.[0]).toBe("yes");
      await direct.execute("listen okm_p107_direct");
      const channels = await direct.execute("select count(*)::text from pg_listening_channels()");
      expect(channels.rows[0]?.[0]).not.toBe("0");
      await direct.execute("prepare okm_p107_direct as select 1");
      const prepared = await direct.execute("execute okm_p107_direct");
      expect(prepared.rows).toEqual([["1"]]);

      // One small compute can hand the same backend out again, so these are
      // recorded and not asserted. A second connection seeing the setting is
      // that reuse, not a promise.
      await pooler.execute("select set_config('okm.p107', 'yes', false)");
      const same = await pooler.execute("select current_setting('okm.p107', true)");
      console.info(
        `neon pooler same client setting ${same.rows[0]?.[0] === "yes" ? "kept" : "dropped"}`,
      );
      const listenFailed = await rejected(pooler.execute("listen okm_p107_pool"));
      console.info(`neon pooler same client listen ${listenFailed ? "rejected" : "accepted"}`);
      const prepareFailed = await rejected(pooler.execute("prepare okm_p107_pool as select 1"));
      const prepareKept =
        !prepareFailed && !(await rejected(pooler.execute("execute okm_p107_pool")));
      console.info(
        `neon pooler same client prepare ${prepareFailed ? "rejected" : prepareKept ? "kept" : "dropped"}`,
      );
      const seen = await fresh.execute("select current_setting('okm.p107', true)");
      console.info(
        `neon pooler new connection setting ${seen.rows[0]?.[0] === "yes" ? "kept" : "dropped"}`,
      );
    } finally {
      await direct.close();
      await pooler.close();
      await fresh.close();
    }
  }, 60_000);

  test("okm driver test neon reports no failures", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = required("NEON_URL");
    const lines: string[] = [];
    try {
      await run(["driver", "test", "neon"], { stdout: (text) => lines.push(text) });
    } catch (error) {
      throw scrub(error);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    const report = lines.join("");
    expect(
      report.includes("postgres://") ||
        report.includes("neon.tech") ||
        /ep-[a-z0-9-]+/i.test(report),
    ).toBe(false);
    expect(report).toContain("driver neon\n");
    expect(report).not.toContain("\tfail\t");
    expect(cell(report, "r2.commit-loss").slice(2)).toEqual(["unsupported", "no socket to cut"]);
    expect(cell(report, "r2.batch-commit-loss").slice(2)).toEqual([
      "unsupported",
      "no socket to cut",
    ]);
    const counts = countReport(report);
    console.info(`neon driver test ${JSON.stringify(counts)}`);
    expect(counts.pass).toBeGreaterThan(0);
  }, 300_000);
}

function required(key: (typeof LABELS)[number][0]): string {
  const value = process.env[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("neon credential unset");
  return value;
}

async function warm(label: string, target: string): Promise<number> {
  const started = Date.now();
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pool = await open({ url: target, mode: "http", max: 1 });
    try {
      await withTimeout(pool.execute("select 1"), 30_000);
      return Date.now() - started;
    } catch (error) {
      last = error;
    } finally {
      await pool.close();
    }
  }
  throw scrub(last instanceof Error ? last : new Error(`${label} warm-up failed`));
}

async function pollReplica(
  db: {
    okm_p107_note: {
      find(input: {
        where: { id: string };
        route: "replica";
        limit: number;
      }): Promise<readonly unknown[]>;
    };
  },
  id: string,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const rows = await db.okm_p107_note.find({ where: { id }, route: "replica", limit: 5 });
      if (rows.length === 1) return true;
    } catch (error) {
      if (!(error instanceof OkmError) || error.code !== "OKM1843") throw scrub(error);
    }
    await sleep(200);
  }
  throw new Error("replica did not show the primary write within 10s");
}

function cuttingSocket(armed: { on: boolean }): typeof WebSocket {
  return class extends WebSocket {
    override send(data: string | Blob | BufferSource): void {
      super.send(data);
      if (!armed.on || !includesCommit(data)) return;
      armed.on = false;
      setTimeout(() => this.close(), 0);
    }
  };
}

function includesCommit(data: string | Blob | BufferSource): boolean {
  if (typeof data === "string") return data.includes("COMMIT");
  if (data instanceof Uint8Array) return new TextDecoder().decode(data).includes("COMMIT");
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data).includes("COMMIT");
  return false;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

async function rejected(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("postgres://") || message.includes("neon.tech")) throw scrub(error);
    return true;
  }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("postgres://") || error.message.includes("neon.tech"))
    ) {
      throw scrub(error);
    }
    return error;
  }
  throw new Error("expected the call to reject");
}

function cell(report: string, id: string): readonly string[] {
  const line = report.split("\n").find((item) => item.startsWith(`${id}\t`));
  if (line === undefined) throw new Error(`missing ${id}`);
  return line.split("\t");
}

function countReport(report: string): { pass: number; fail: number; unsupported: number } {
  const counts = { pass: 0, fail: 0, unsupported: 0 };
  for (const line of report.split("\n")) {
    const result = line.split("\t")[2];
    if (result === "pass" || result === "fail" || result === "unsupported") counts[result] += 1;
  }
  return counts;
}

function scrub(error: unknown): Error {
  const message = error instanceof Error ? error.message : "neon call failed";
  return new Error(
    message
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
      .replace(/\b[\w.-]*neon\.tech\b/gi, "[host]")
      .replace(/ep-[a-z0-9-]+/gi, "[endpoint]"),
  );
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("warm-up timed out")), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
