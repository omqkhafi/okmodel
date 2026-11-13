/**
 * A refused or dropped connection is `unavailable` on every driver.
 *
 * postgres.js already reported that. node-postgres, Bun.sql, and Neon did not.
 * The pool message "timeout exceeded when trying to connect" is not covered here.
 */

import { connect as connectTcp, createServer, type Server, type Socket } from "node:net";

import { expect } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";

import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { OkmError } from "../src/contracts/error.js";
import { fragment, raw, schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectNeon } from "../src/runtime/pg/neon.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();
const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });
const DEAD = "postgres://okm:okm@127.0.0.1:1/okm";

class Cell {
  ok = "";
}

type Db = {
  notes: {
    find(options: { limit: number }): Promise<unknown>;
    insert(row: { id: number; title: string }): Promise<unknown>;
  };
  close(): Promise<void>;
};

const wire = {
  postgresjs: (url: string) => connectPostgres(url, { schema: app, max: 1 }) as unknown as Db,
  pg: (url: string) => connectPg(url, { schema: app, max: 1 }) as unknown as Db,
  bun: (url: string) => connectBun(url, { schema: app, max: 1 }) as unknown as Db,
};

function assertUnavailable(error: unknown, detail: string | undefined): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.kind).toBe("unavailable");
  expect(error.retryable).toBe(true);
  expect(error.cause).toBeTruthy();
  if (detail !== undefined) expect(JSON.stringify(error.cause)).toContain(detail);
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

async function once(db: Db): Promise<void> {
  const rows = await raw(db.notes, Cell, "read", fragment`select 1::text as ok`);
  expect(rows[0]?.ok).toBe("1");
}

function sleep(db: Db): Promise<unknown> {
  return raw(db.notes, Cell, "read", fragment`select pg_sleep(2)::text as ok`);
}

type Gate = {
  readonly url: string;
  cut(): void;
  close(): Promise<void>;
};

function proxy(upstream: string): Promise<Gate> {
  const target = new URL(upstream);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  const listening = createServer((client) => {
    const remote = connectTcp(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(remote);
    client.pipe(remote);
    remote.pipe(client);
    client.on("error", () => undefined);
    remote.on("error", () => undefined);
  });
  server = listening;
  return new Promise((resolve) => {
    listening.listen(0, "127.0.0.1", () => {
      const address = listening.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      let closed = false;
      resolve({
        url: `postgres://okm:okm@127.0.0.1:${String(port)}/okm`,
        cut() {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        },
        close: () =>
          new Promise((done) => {
            if (closed || server === undefined) {
              done();
              return;
            }
            closed = true;
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

for (const name of ["postgresjs", "pg", "bun"] as const) {
  const detail = name === "bun" ? "ERR_POSTGRES_CONNECTION_REFUSED" : "ECONNREFUSED";

  postgresTest(
    gate,
    `${name}: a refused connection at startup is unavailable`,
    async () => {
      const db = wire[name](DEAD);
      try {
        assertUnavailable(await caught(() => db.notes.find({ limit: 1 })), detail);
      } finally {
        await db.close().catch(() => undefined);
      }
    },
    10_000,
  );

  postgresTest(
    gate,
    `${name}: a socket dropped mid-query is unavailable`,
    async () => {
      const front = await proxy(primaryUrl());
      const db = wire[name](front.url);
      try {
        await once(db);
        const pending = sleep(db);
        await Bun.sleep(50);
        front.cut();
        await front.close();
        const error = await caught(() => pending);
        assertUnavailable(error, name === "pg" ? "Connection terminated unexpectedly" : undefined);
      } finally {
        await db.close().catch(() => undefined);
        await front.close();
      }
    },
    15_000,
  );

  postgresTest(
    gate,
    `${name}: two queries in flight are unavailable and the next call succeeds`,
    async () => {
      const front = await proxy(primaryUrl());
      const db = wire[name](front.url);
      try {
        await once(db);
        const first = caught(() => sleep(db));
        const second = caught(() => sleep(db));
        await Bun.sleep(50);
        front.cut();
        await front.close();
        assertUnavailable(await first, undefined);
        assertUnavailable(await second, undefined);
      } finally {
        await db.close().catch(() => undefined);
        await front.close();
      }
      const live = wire[name](primaryUrl());
      try {
        await once(live);
      } finally {
        await live.close();
      }
    },
    15_000,
  );

  postgresTest(
    gate,
    `${name}: a unique violation stays unique and a syntax error stays driver`,
    async () => {
      const database = await createIsolatedDatabase();
      const admin = openPostgres(database.url);
      const db = wire[name](database.url);
      try {
        await admin.unsafe("create table notes (id int primary key, title text not null)");
        await db.notes.insert({ id: 1, title: "a" });
        const unique = await caught(() => db.notes.insert({ id: 1, title: "b" }));
        expect(unique).toBeInstanceOf(OkmError);
        if (unique instanceof OkmError) expect(unique.kind).toBe("unique");
        const syntax = await caught(() =>
          raw(db.notes, Cell, "read", fragment`select not_a_real_function()`),
        );
        expect(syntax).toBeInstanceOf(OkmError);
        if (syntax instanceof OkmError) {
          expect(syntax.kind).toBe("driver");
          expect(syntax.sqlstate).toBe("42883");
        }
      } finally {
        await db.close().catch(() => undefined);
        await admin.end({ timeout: 1 }).catch(() => undefined);
        await database.close();
      }
    },
    15_000,
  );
}

const neonSaved = {
  fetchEndpoint: neonConfig.fetchEndpoint,
  wsProxy: neonConfig.wsProxy,
  useSecureWebSocket: neonConfig.useSecureWebSocket,
  forceDisablePgSSL: neonConfig.forceDisablePgSSL,
  pipelineConnect: neonConfig.pipelineConnect,
  pipelineTLS: neonConfig.pipelineTLS,
};

function pointNeon(port: number): void {
  neonConfig.fetchEndpoint = () => `http://127.0.0.1:${String(port)}/sql`;
  neonConfig.wsProxy = () => `127.0.0.1:${String(port)}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
}

function restoreNeon(): void {
  neonConfig.fetchEndpoint = neonSaved.fetchEndpoint;
  neonConfig.wsProxy = neonSaved.wsProxy;
  neonConfig.useSecureWebSocket = neonSaved.useSecureWebSocket;
  neonConfig.forceDisablePgSSL = neonSaved.forceDisablePgSSL;
  neonConfig.pipelineConnect = neonSaved.pipelineConnect;
  neonConfig.pipelineTLS = neonSaved.pipelineTLS;
}

async function neonDb(mode: "websocket" | "http", url: string): Promise<Db> {
  return connectNeon(url, { schema: app, mode, max: 1 }) as unknown as Promise<Db>;
}

postgresTest(
  gate,
  "neon websocket: a refused connection is an unavailable OkmError",
  async () => {
    pointNeon(1);
    try {
      assertUnavailable(
        await caught(() => neonDb("websocket", "postgres://okm:okm@neon.local/okm")),
        "WebSocket connection to ",
      );
    } finally {
      restoreNeon();
    }
  },
  10_000,
);

postgresTest(
  gate,
  "neon websocket: a dropped endpoint is unavailable and the next call succeeds",
  async () => {
    const local = startNeonLocal(primaryUrl());
    const db = await neonDb("websocket", local.url);
    try {
      await once(db);
      const pending = sleep(db);
      await Bun.sleep(50);
      await local.close();
      assertUnavailable(await caught(() => pending), "Connection terminated unexpectedly");
    } finally {
      await db.close().catch(() => undefined);
      await local.close().catch(() => undefined);
    }
    const again = startNeonLocal(primaryUrl());
    const live = await neonDb("websocket", again.url);
    try {
      await once(live);
    } finally {
      await live.close().catch(() => undefined);
      await again.close();
      restoreNeon();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "neon http: a refused connection and a reset connection are unavailable",
  async () => {
    pointNeon(1);
    const refused = await neonDb("http", "postgres://okm:okm@neon.local/okm");
    try {
      assertUnavailable(await caught(() => refused.notes.find({ limit: 1 })), "ConnectionRefused");
    } finally {
      await refused.close().catch(() => undefined);
    }
    const reset = createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", () => resolve()));
    const address = reset.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    pointNeon(port);
    const db = await neonDb("http", "postgres://okm:okm@neon.local/okm");
    try {
      assertUnavailable(await caught(() => db.notes.find({ limit: 1 })), "ECONNRESET");
    } finally {
      await db.close().catch(() => undefined);
      await new Promise<void>((done) => reset.close(() => done()));
      restoreNeon();
    }
  },
  10_000,
);

postgresTest(
  gate,
  "neon: a unique violation stays unique and a syntax error stays driver",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    let local: NeonLocal | undefined;
    try {
      await admin.unsafe("create table notes (id int primary key, title text not null)");
      local = startNeonLocal(database.url);
      for (const mode of ["websocket", "http"] as const) {
        const db = await neonDb(mode, local.url);
        try {
          await db.notes.insert({ id: mode === "websocket" ? 1 : 2, title: "a" });
          const unique = await caught(() =>
            db.notes.insert({ id: mode === "websocket" ? 1 : 2, title: "b" }),
          );
          expect(unique).toBeInstanceOf(OkmError);
          if (unique instanceof OkmError) expect(unique.kind).toBe("unique");
          const syntax = await caught(() =>
            raw(db.notes, Cell, "read", fragment`select not_a_real_function()`),
          );
          expect(syntax).toBeInstanceOf(OkmError);
          if (syntax instanceof OkmError) {
            expect(syntax.kind).toBe("driver");
            expect(syntax.sqlstate).toBe("42883");
          }
        } finally {
          await db.close().catch(() => undefined);
        }
      }
    } finally {
      await local?.close();
      await admin.end({ timeout: 1 }).catch(() => undefined);
      await database.close();
      restoreNeon();
    }
  },
  20_000,
);
