/**
 * Hono on Bun (`bun ./src/server.ts`).
 */

import { app } from "./app.js";
import { closeDb } from "./db.js";

const port = Number(process.env.PORT ?? "3102");

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`hono (bun) example on ${port}`);

process.on("SIGINT", () => void closeDb());
process.on("SIGTERM", () => void closeDb());
