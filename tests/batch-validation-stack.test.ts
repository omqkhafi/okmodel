/**
 * A batched OKM1200 keeps the stack from the validation throw.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, text } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { v } from "../src/runtime/validate/index.js";

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [], count: 0, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

test("batch keeps the validation frame on OKM1200", async () => {
  const posts = table(
    "posts",
    {
      title: text().validate([v.min(8, "post_short")]),
    },
    { validation: true },
  );
  const app = schema({ tables: [posts], validation: true });
  const db = createClient(app, pool, { ownsPool: false });
  void db.connected.catch(() => undefined);
  try {
    await db.batch([db.posts.insert({ title: "no" })]);
    throw new Error("expected OKM1200");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (!(error instanceof OkmError)) return;
    expect(error.code).toBe("OKM1200");
    expect(error.batchIndex).toBe(0);
    expect(error.stack).toContain("throwIssues");
    expect(error.stack).not.toContain("stampValidation");
  }
});
