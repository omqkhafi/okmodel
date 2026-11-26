/**
 * Pooler URL shapes. No connection and no secret.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import {
  assertDirectConnection,
  detectPooler,
  poolerSignal,
} from "../src/tooling/migrate/pooler.js";
import { resolvePooler } from "../src/tooling/migrate/pooler-probe.js";
import { listenPostgres } from "./doc-run.js";

test("proof:pooler.detect", () => {
  expect(detectPooler({ url: "postgres://u@ep-cool-pooler.region.aws.neon.tech/db" }).signal).toBe(
    "host",
  );
  expect(
    detectPooler({ url: "postgres://u@aws-0-us-east-1.pooler.supabase.com:6543/db" }).pooled,
  ).toBe(true);
  expect(detectPooler({ url: "postgres://u@db.example:6543/db" }).signal).toBe("port");
  expect(detectPooler({ url: "postgres://u@db.example:6432/db" }).signal).toBe("port");
  expect(detectPooler({ url: "postgres://u@db.example:5432/db?pgbouncer=true" }).signal).toBe(
    "parameter",
  );
  expect(detectPooler({ url: "postgres://u@pgbouncer.internal/db" }).signal).toBe("host");
  expect(detectPooler({ url: "postgres://u@db-pooler.example.com/app" }).signal).toBe("host");
  const quiet = detectPooler({ url: "postgres://u@db.example:5432/db" });
  expect(quiet.pooled).toBe(false);
  expect(quiet.provenDirect).toBe(false);
  const shared = detectPooler({
    url: "postgres://u@db.example:5432/db",
    concurrent: { clients: 8, distinct: 4, changed: false },
  });
  expect(shared.pooled).toBe(true);
  expect(shared.signal).toBe("pid");
  expect(shared.detail).toBe("fewer backends than clients");
  const moved = detectPooler({
    url: "postgres://u@db.example:5432/db",
    concurrent: { clients: 8, distinct: 8, changed: true },
  });
  expect(moved.pooled).toBe(true);
  expect(moved.detail).toContain("pid changed");
  const direct = detectPooler({
    url: "postgres://u@db.example:5432/db",
    concurrent: { clients: 8, distinct: 8, changed: false },
  });
  expect(direct.provenDirect).toBe(true);
  expect(direct.pooled).toBe(false);
  const urlWins = detectPooler({
    url: "postgres://u@db.example:6543/db",
    concurrent: { clients: 8, distinct: 8, changed: false },
  });
  expect(urlWins.provenDirect).toBe(false);
  expect(urlWins.signal).toBe("port");
  const idlePool = detectPooler({
    url: "postgres://u@ep-cool-pooler.region.aws.neon.tech/db",
  });
  expect(idlePool.pooled).toBe(true);
  expect(idlePool.provenDirect).toBe(false);
  expect(detectPooler({ url: "postgres://u@db.example:5432/db", marker: true }).signal).toBe(
    "config",
  );
  expect(poolerSignal("postgres://u@db.pooler.example/app")).toBe("host");
});

test("a URL signal and allowPooler skip the eight clients", async () => {
  const port = await resolvePooler("postgres://u@db.example:6543/db");
  expect(port.signal).toBe("port");
  expect(port.provenDirect).toBe(false);
  const marked = await resolvePooler("postgres://u@db.example:5432/db", true);
  expect(marked.signal).toBe("config");
  expect(marked.provenDirect).toBe(false);
});

test("PGlite is one process and is not a pooler", async () => {
  const server = await listenPostgres();
  try {
    const found = await resolvePooler(server.url);
    expect(found.pooled).toBe(false);
    expect(found.provenDirect).toBe(false);
  } finally {
    await server.close();
  }
});

test("a session URL that matches a pooler signal is refused", () => {
  expect(() => assertDirectConnection("postgres://u@db.example:6543/db", false)).toThrow(OkmError);
  expect(() => assertDirectConnection("postgres://u@db.example:6543/db", true)).not.toThrow();
  try {
    assertDirectConnection("postgres://zq_user:zq_pass@db-pooler.zq-host.example:6543/app", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("direct");
    expect(message).not.toContain("zq_user");
    expect(message).not.toContain("zq_pass");
    expect(message).not.toContain("6543");
  }
});
