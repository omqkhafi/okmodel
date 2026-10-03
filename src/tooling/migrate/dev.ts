/**
 * `okm dev`.
 *
 * When a target named `dev` is configured, the command names it. Otherwise it
 * creates a PGlite database in `.okm/dev-db`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { listTargets } from "./policy.js";
import { loadConfig } from "./project.js";

/**
 * Starts the dev database.
 *
 * A configured target named `dev` is used as it is. With no such target,
 * PGlite is opened on `.okm/dev-db` so the directory exists for the app.
 *
 * @param cwd - Project directory
 * @returns The target line, or the data directory
 */
export async function devProject(cwd: string): Promise<string> {
  const config = await loadConfig(cwd);
  const named = listTargets(config).find((target) => target.name === "dev");
  if (named !== undefined) return `target ${named.name}\n`;
  const directory = join(cwd, config.out ?? ".okm", "dev-db");
  mkdirSync(directory, { recursive: true });
  const { open } = await import("../../adapters/pg/pglite.js");
  const pool = await open({ dataDir: directory });
  try {
    await pool.execute("select 1");
  } finally {
    await pool.close();
  }
  return `${directory}\n`;
}
