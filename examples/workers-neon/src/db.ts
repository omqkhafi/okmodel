/**
 * Per-request Neon client for Cloudflare Workers.
 *
 * Create inside `fetch`. Close with `ctx.waitUntil(db.close())` so the
 * isolate does not hold the pool across requests.
 */

import { connect, type NeonMode } from "okmodel/pg/neon";

import { app } from "./schema.js";

/**
 * Opens a Neon client for one request.
 *
 * @param url - Neon connection string
 * @param mode - `websocket` (default) or `http`
 */
export function openRequestDb(url: string, mode: NeonMode = "websocket") {
  return connect(url, { schema: app, mode });
}
