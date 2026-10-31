/**
 * Hono on Node via `@hono/node-server`.
 */

import { serve } from "@hono/node-server";

import { app } from "./app.js";
import { closeDb } from "./db.js";

const port = Number(process.env.PORT ?? "3102");

serve({ fetch: app.fetch, port }, () => {
  console.log(`hono (node) example on ${port}`);
});

process.on("SIGINT", () => void closeDb());
process.on("SIGTERM", () => void closeDb());
