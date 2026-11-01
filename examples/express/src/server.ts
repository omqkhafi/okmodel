/**
 * Smallest Express app: GET reads notes, POST writes one.
 */

import express from "express";

import { closeDb, db } from "./db.js";

const port = Number(process.env.PORT ?? "3101");
const app = express();
app.use(express.json());

app.get("/notes", async (_req, res, next) => {
  try {
    const rows = await db.example_notes.find({
      orderBy: { id: "asc" },
      limit: 50,
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post("/notes", async (req, res, next) => {
  try {
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    if (title === undefined || title.length === 0) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const row = await db.example_notes.insert({ title });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(port, () => {
  console.log(`express example on ${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await closeDb();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
