/**
 * Cloudflare Worker: per-request Neon connect, read and write routes.
 *
 * Requires `nodejs_compat`. WebSocket mode supports `tx()`. HTTP mode uses
 * `batch()` and refuses `tx()` (OKM1111).
 */

import { openRequestDb } from "./db.js";

export interface Env {
  DATABASE_URL: string;
  NEON_MODE?: string;
}

function neonMode(value: string | undefined): "websocket" | "http" {
  if (value === undefined || value === "websocket") return "websocket";
  if (value === "http") return "http";
  throw new Error(`NEON_MODE must be "websocket" or "http", got ${JSON.stringify(value)}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const mode = neonMode(env.NEON_MODE);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, mode });
    }
    if (url.pathname !== "/notes") return new Response("not found", { status: 404 });

    const db = await openRequestDb(env.DATABASE_URL, mode);
    try {
      if (request.method === "GET") {
        const rows = await db.example_notes.find({
          orderBy: { id: "asc" },
          limit: 50,
        });
        return Response.json(rows);
      }
      if (request.method === "POST") {
        // No authentication and no body size limit: add both before real traffic.
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "body must be JSON" }, { status: 400 });
        }
        const title =
          body !== null && typeof body === "object" && "title" in body
            ? (body as { title: unknown }).title
            : undefined;
        if (typeof title !== "string" || title.length === 0) {
          return Response.json({ error: "title is required" }, { status: 400 });
        }
        if (mode === "websocket") {
          const row = await db.tx(async (tx) => tx.example_notes.insert({ title }));
          return Response.json(row, { status: 201 });
        }
        // HTTP mode has no interactive transaction; batch is one atomic unit.
        const [row] = await db.batch([db.example_notes.insert({ title })]);
        return Response.json(row, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    } finally {
      ctx.waitUntil(db.close());
    }
  },
};
