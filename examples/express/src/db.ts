/**
 * Process-scoped client for the Express example.
 *
 * One connect for the process. Close on shutdown. Hot reload in frameworks
 * that remount modules creates a new client; call `close()` before exit.
 */

import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema.js";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is required");
}

/** Shared client for this process. */
export const db = connect(url, { schema: app });

/** Closes the process client. */
export async function closeDb(): Promise<void> {
  await db.close();
}
