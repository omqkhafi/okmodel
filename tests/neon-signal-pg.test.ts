/**
 * Neon startup bounds and per-call abort, in both modes.
 *
 * A silent TCP listener stands in for an unresponsive endpoint. The local
 * Neon endpoint (`startNeonLocal`) is the real driver against Postgres. An
 * abort after a statement is sent settles with that statement's result. An
 * abort that is already fired is `cancelled` and writes nothing.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import pg from "pg";
import { neonConfig } from "@neondatabase/serverless";

import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/neon.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/neon.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const notes = table(`okm_sig_${suffix}`, {
  id: t.integer().primaryKey(),
  title: t.text(),
});
const app = schema({ casing: "snake", tables: [notes] });
const MODES = ["http", "websocket"] as const;
const url = `postgres://okm:okm@neon.local/okm`;

let local: NeonLocal | undefined;
let tail: Promise<void> = Promise.resolve();

beforeAll(async () => {
  if (!gate.run) return;
  local = startNeonLocal(primaryUrl());
  const pool = await open({ url: local.url, max: 1 });
  try {
    await pool.execute(`create table okm_sig_${suffix} (id integer primary key, title text)`);
    await pool.execute(`insert into okm_sig_${suffix} values (1, 'held')`);
  } finally {
    await pool.close();
  }
}, 30_000);

afterAll(async () => {
  if (local === undefined) return;
  const pool = await open({ url: local.url, max: 1 }).catch(() => undefined);
  try {
    await pool?.execute(`drop table if exists okm_sig_${suffix}`);
  } finally {
    await pool?.close();
    await local.close();
  }
}, 30_000);

for (const mode of MODES) {
  postgresTest(
    gate,
    `${mode}: a blackhole startup signal settles cancelled at about 2s`,
    queued(() =>
      crashes(async () => {
        const hole = silent();
        try {
          point(hole.host);
          const started = performance.now();
          const db = await connect(url, {
            schema: app,
            mode,
            signal: AbortSignal.timeout(2_000),
          });
          const error = await rejected(db.connected);
          const elapsed = performance.now() - started;
          expectKind(error, "cancelled", false);
          expect(elapsed).toBeGreaterThan(1_500);
          expect(elapsed).toBeLessThan(3_500);
          await expectClose(db);
        } finally {
          hole.stop();
          restore();
        }
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: a blackhole startup timeout settles timeout at about 2s`,
    queued(() =>
      crashes(async () => {
        const hole = silent();
        try {
          point(hole.host);
          const started = performance.now();
          const db = await connect(url, { schema: app, mode, timeout: 2_000 });
          const error = await rejected(db.connected);
          const elapsed = performance.now() - started;
          expectKind(error, "timeout", true);
          expect(error.message).toBe("The call timed out");
          expect(elapsed).toBeGreaterThan(1_500);
          expect(elapsed).toBeLessThan(3_500);
          await expectClose(db);
        } finally {
          hole.stop();
          restore();
        }
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: a healthy endpoint accepts connect timeout 5000`,
    queued(() =>
      crashes(async () => {
        const db = await connect(local!.url, { schema: app, mode, timeout: 5_000 });
        try {
          await db.connected;
          const rows = await db[notes.name]!.find({ limit: 1 });
          expect(rows).toEqual([{ id: 1, title: "held" }]);
        } finally {
          await expectClose(db);
        }
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: an update blocked for 4s with a 1s signal keeps the write`,
    queued(() =>
      crashes(async () => {
        const db = await connect(local!.url, { schema: app, mode, max: 1 });
        try {
          await db.connected;
          await hold(async () => {
            const started = performance.now();
            const written = await db[notes.name]!.update(
              { where: { id: 1 }, set: { title: "next" } },
              { signal: AbortSignal.timeout(1_000) },
            );
            const elapsed = performance.now() - started;
            expect(written).toEqual({ count: 1 });
            expect(elapsed).toBeGreaterThan(3_000);
            expect(elapsed).toBeLessThan(6_000);
            const rows = await db[notes.name]!.find({ limit: 1 });
            expect(rows).toEqual([{ id: 1, title: "next" }]);
          });
        } finally {
          await db.close();
        }
        await resetTitle();
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: an already-aborted signal writes nothing`,
    queued(() =>
      crashes(async () => {
        const db = await connect(local!.url, { schema: app, mode });
        try {
          await db.connected;
          const controller = new AbortController();
          controller.abort();
          const error = await rejected(
            db[notes.name]!.update(
              { where: { id: 1 }, set: { title: "nope" } },
              { signal: controller.signal },
            ),
          );
          expectKind(error, "cancelled", false);
          const rows = await db[notes.name]!.find({ limit: 1 });
          expect(rows).toEqual([{ id: 1, title: "held" }]);
          const refused = await rejected(
            db[notes.name]!.update({ where: { id: 1 }, set: { title: "nope" } }, { timeout: 50 }),
          );
          expect(refused.code).toBe("OKM1120");
          expect(refused.kind).toBe("invalid");
        } finally {
          await db.close();
        }
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: a read aborted mid-flight returns its rows`,
    queued(() =>
      crashes(async () => {
        const db = await connect(local!.url, { schema: app, mode });
        try {
          await db.connected;
          await locked(async (release) => {
            const started = performance.now();
            // `find` does not send until something awaits it. Await a copy so the
            // statement is in flight before the signal fires.
            const pending = Promise.resolve(
              db[notes.name]!.find({
                limit: 1,
                signal: AbortSignal.timeout(1_000),
              }),
            );
            pending.catch(() => undefined);
            await Bun.sleep(2_000);
            release();
            const rows = await pending;
            expect(performance.now() - started).toBeGreaterThan(1_800);
            expect(rows).toEqual([{ id: 1, title: "held" }]);
          });
        } finally {
          await db.close();
        }
      }),
    ),
    20_000,
  );

  postgresTest(
    gate,
    `${mode}: an abort in the same tick as the response is the write, once`,
    queued(() =>
      crashes(async () => {
        const controller = new AbortController();
        const previousFetch = neonConfig.fetchFunction;
        const previousSocket = neonConfig.webSocketConstructor;
        const arm = { current: undefined as AbortController | undefined };
        if (mode === "http") {
          neonConfig.fetchFunction = async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init);
            if (bodyText(init?.body).toLowerCase().includes("update")) controller.abort();
            return response;
          };
        } else {
          neonConfig.webSocketConstructor = armingSocket(arm);
        }
        const db = await connect(local!.url, { schema: app, mode, max: 1 });
        let settlements = 0;
        try {
          await db.connected;
          arm.current = controller;
          const pending = db[notes.name]!.update(
            { where: { id: 1 }, set: { title: "tick" } },
            { signal: controller.signal },
          ).then(
            (value) => {
              settlements += 1;
              return value;
            },
            (error: unknown) => {
              settlements += 1;
              throw error;
            },
          );
          const written = await pending;
          expect(settlements).toBe(1);
          expect(controller.signal.aborted).toBe(true);
          expect(written).toEqual({ count: 1 });
          const rows = await db[notes.name]!.find({ limit: 1 });
          expect(rows).toEqual([{ id: 1, title: "tick" }]);
        } finally {
          neonConfig.fetchFunction = previousFetch;
          neonConfig.webSocketConstructor = previousSocket;
          arm.current = undefined;
          await db.close();
          await resetTitle();
        }
      }),
    ),
    20_000,
  );
}

function queued(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    const previous = tail;
    let release: () => void = () => undefined;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await body();
    } finally {
      release();
    }
  };
}

async function crashes(body: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const onReject = (error: unknown): void => {
    seen.push(error);
  };
  const onThrow = (error: unknown): void => {
    seen.push(error);
  };
  process.on("unhandledRejection", onReject);
  process.on("uncaughtException", onThrow);
  try {
    await body();
    await Bun.sleep(50);
  } finally {
    process.off("unhandledRejection", onReject);
    process.off("uncaughtException", onThrow);
  }
  expect(seen).toEqual([]);
}

function silent(): { readonly host: string; stop(): void } {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  return { host: `127.0.0.1:${String(listener.port)}`, stop: () => listener.stop(true) };
}

function point(host: string): void {
  neonConfig.fetchEndpoint = () => `http://${host}/sql`;
  neonConfig.wsProxy = () => `${host}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
}

function restore(): void {
  if (local === undefined) return;
  point(local.host);
}

async function expectClose(db: { close(): Promise<void> }): Promise<void> {
  const started = performance.now();
  await db.close();
  expect(performance.now() - started).toBeLessThan(1_000);
}

function expectKind(error: OkmError, kind: "cancelled" | "timeout", retryable: boolean): void {
  expect(error.kind).toBe(kind);
  expect(error.code).toBe(kind);
  expect(error.retryable).toBe(retryable);
}

async function rejected(work: Promise<unknown>): Promise<OkmError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("the call resolved");
}

async function hold(body: () => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: primaryUrl(), max: 1 });
  const holder = await pool.connect();
  await holder.query("begin");
  await holder.query(`select id from okm_sig_${suffix} where id = 1 for update`);
  const done = Bun.sleep(4_000).then(() => holder.query("commit"));
  try {
    await body();
  } finally {
    await done.catch(() => undefined);
    holder.release();
    await pool.end();
  }
}

async function locked(body: (release: () => void) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: primaryUrl(), max: 1 });
  const holder = await pool.connect();
  await holder.query("begin");
  await holder.query(`lock table okm_sig_${suffix} in access exclusive mode`);
  let committing: Promise<unknown> | undefined;
  const release = (): void => {
    committing ??= holder.query("commit");
  };
  try {
    await body(release);
  } finally {
    release();
    await committing?.catch(() => undefined);
    holder.release();
    await pool.end();
  }
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

async function resetTitle(): Promise<void> {
  const pool = new pg.Pool({ connectionString: primaryUrl(), max: 1 });
  try {
    await pool.query({
      text: `update okm_sig_${suffix} set title = 'held' where id = 1`,
    });
  } finally {
    await pool.end();
  }
}

function armingSocket(arm: { current: AbortController | undefined }): typeof WebSocket {
  const Base = (neonConfig.webSocketConstructor ?? WebSocket) as typeof WebSocket;
  return class ArmingSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const listen = this.addEventListener.bind(this);
      this.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type !== "message" || typeof listener !== "function") {
          listen(type, listener, options);
          return;
        }
        listen(
          type,
          (event) => {
            arm.current?.abort();
            listener.call(this, event);
          },
          options,
        );
      }) as typeof this.addEventListener;
    }
  };
}
