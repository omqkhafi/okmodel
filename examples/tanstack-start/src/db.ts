/**
 * Process-scoped client for the TanStack Start example.
 */

import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema";

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
