import { connect, type NeonMode } from "okmodel/pg/neon";

import { app } from "./schema.ts";

/** Opens a Neon client for one request. Close it when the request is done. */
export function openDb(url: string, mode: NeonMode) {
  return connect(url, { schema: app, mode });
}

export type Db = Awaited<ReturnType<typeof openDb>>;

/** Reads NEON_MODE. A typo fails loudly instead of falling back. */
export function neonMode(value: string | undefined): NeonMode {
  if (value === undefined || value === "websocket") return "websocket";
  if (value === "http") return "http";
  throw new Error(`NEON_MODE must be "websocket" or "http", got ${JSON.stringify(value)}`);
}
