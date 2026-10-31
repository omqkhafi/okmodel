/**
 * Process-scoped client for the Next.js example.
 *
 * In `next dev`, Fast Refresh can remount this module. Prefer one connect per
 * process via `globalThis` so hot reload does not leak pools.
 */

import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema";

type GlobalDb = {
  __okmExampleDb?: ReturnType<typeof connect>;
};

const globalDb = globalThis as GlobalDb;

function open() {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  return connect(url, { schema: app });
}

/** Shared client for this Node process. */
export const db = globalDb.__okmExampleDb ?? open();

if (process.env.NODE_ENV !== "production") {
  globalDb.__okmExampleDb = db;
}

/** Closes the process client. */
export async function closeDb(): Promise<void> {
  await db.close();
  delete globalDb.__okmExampleDb;
}
