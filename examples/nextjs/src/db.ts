/**
 * Process-scoped client for the Next.js example.
 *
 * Use the Node.js runtime only (`export const runtime = "nodejs"` on routes).
 * The Edge runtime is not supported here: postgres.js needs TCP.
 */

import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is required");
}

/** Shared client for this Node process. */
export const db = connect(url, { schema: app });

/** Closes the process client. */
export async function closeDb(): Promise<void> {
  await db.close();
}
