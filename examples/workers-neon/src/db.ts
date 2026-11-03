/**
 * Per-request Neon client for Cloudflare Workers.
 *
 * Open it in a middleware and close it after the response and any background
 * work settle, so the isolate does not hold a pool across requests.
 */

import { connect, type NeonMode } from "okmodel/pg/neon";

import { app } from "./schema.ts";

/**
 * Opens a Neon client for one request.
 *
 * @param url - Neon connection string
 * @param mode - `websocket` (default) or `http`
 */
export function openRequestDb(url: string, mode: NeonMode = "websocket") {
  return connect(url, { schema: app, mode });
}
