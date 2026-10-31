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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const mode = env.NEON_MODE === "http" ? "http" : "websocket";
    const db = await openRequestDb(env.DATABASE_URL, mode);
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, mode });
      }
      if (request.method === "GET" && url.pathname === "/notes") {
        const rows = await db.example_notes.find({ limit: 50 });
        return Response.json(rows);
      }
      if (request.method === "POST" && url.pathname === "/notes") {
        const body = (await request.json().catch(() => ({}))) as { title?: string };
        const title = typeof body.title === "string" ? body.title : "untitled";
        if (mode === "websocket") {
          const row = await db.tx(async (tx) => tx.example_notes.insert({ title }));
          return Response.json(row, { status: 201 });
        }
        const [row] = await db.batch([db.example_notes.insert({ title })]);
        return Response.json(row, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    } finally {
      ctx.waitUntil(Promise.resolve(db.close()));
    }
  },
};
