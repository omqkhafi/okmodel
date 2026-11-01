/**
 * Hono routes shared by the Bun and Node servers.
 */

import { Hono } from "hono";

import { db } from "./db.js";

/** Application routes. */
export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/notes", async (c) => {
  const rows = await db.example_notes.find({
    orderBy: { id: "asc" },
    limit: 50,
  });
  return c.json(rows);
});

app.post("/notes", async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title : undefined;
  if (title === undefined || title.length === 0) {
    return c.json({ error: "title is required" }, 400);
  }
  const row = await db.example_notes.insert({ title });
  return c.json(row, 201);
});
