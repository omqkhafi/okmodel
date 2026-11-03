/**
 * Cloudflare Worker on Hono: a per-request Neon client, read and write routes.
 *
 * Requires `nodejs_compat`. WebSocket mode supports `tx()`. HTTP mode uses
 * `batch()` and refuses `tx()` (OKM1111). `Env` comes from `wrangler types`.
 */

import { Hono } from "hono";

import { openRequestDb } from "./db.ts";

type Mode = "websocket" | "http";
type Db = Awaited<ReturnType<typeof openRequestDb>>;
type Vars = { mode: Mode; db: Db; pending: Promise<unknown>[] };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function neonMode(value: string | undefined): Mode {
  if (value === undefined || value === "websocket") return "websocket";
  if (value === "http") return "http";
  throw new Error(`NEON_MODE must be "websocket" or "http", got ${JSON.stringify(value)}`);
}

// A typo in NEON_MODE fails every request instead of falling back.
app.use(async (c, next) => {
  const mode: string = c.env.NEON_MODE;
  c.set("mode", neonMode(mode));
  await next();
});

// Only /notes opens a client. It closes after every pushed promise settles.
app.use("/notes/*", async (c, next) => {
  const db = await openRequestDb(c.env.DATABASE_URL, c.get("mode"));
  const pending: Promise<unknown>[] = [];
  c.set("db", db);
  c.set("pending", pending);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(Promise.allSettled(pending).then(() => db.close()));
  }
});

app.get("/health", (c) => c.json({ ok: true, mode: c.get("mode") }));

app.get("/notes", async (c) => {
  const rows = await c.get("db").example_notes.find({ orderBy: { id: "asc" }, limit: 50 });
  return c.json(rows);
});

app.post("/notes", async (c) => {
  // No authentication and no body size limit: add both before real traffic.
  const input = await readNote(c.req.raw);
  if ("error" in input) return c.json(input, 400);
  const db = c.get("db");
  if (c.get("mode") === "websocket") {
    const row = await db.tx(async (tx) => tx.example_notes.insert(input));
    return c.json(row, 201);
  }
  // HTTP mode has no interactive transaction; batch is one atomic unit.
  const [row] = await db.batch([db.example_notes.insert(input)]);
  return c.json(row, 201);
});

app.post("/notes/later", async (c) => {
  const input = await readNote(c.req.raw);
  if ("error" in input) return c.json(input, 400);
  // Not awaited: the response does not wait for the insert.
  c.get("pending").push(c.get("db").example_notes.insert(input));
  return c.body(null, 202);
});

app.notFound((c) => c.text("not found", 404));

// Rethrow so the runtime logs the error and answers 500.
app.onError((error) => {
  throw error;
});

type NoteInput = { title: string; dueOn: string | null };

async function readNote(request: Request): Promise<NoteInput | { error: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: "body must be JSON" };
  }
  const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const { title, dueOn } = fields;
  if (typeof title !== "string" || title.length === 0) return { error: "title is required" };
  if (dueOn !== undefined && dueOn !== null && typeof dueOn !== "string") {
    return { error: "dueOn must be a YYYY-MM-DD string" };
  }
  return { title, dueOn: dueOn ?? null };
}

export default app;
