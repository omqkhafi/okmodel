/**
 * A PGlite database copied from a directory that already has its DDL.
 *
 * `memory://` runs initdb on every open. These topology tests open a primary
 * and two replicas per case, so that init is most of the file. The first call
 * for a statement list builds one directory. Later calls copy it.
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverPool } from "../../../src/contracts/driver.js";

const templates = new Map<string, Promise<string>>();

/**
 * Opens a PGlite pool whose schema is `statements`.
 *
 * The copy is independent of the template and of every other pool. `close`
 * deletes the copy.
 *
 * @param statements - DDL applied once to the template, in order
 * @param options - Acquire timeout forwarded to the adapter
 * @returns A pool on a fresh copy of the template
 */
export async function openPreparedPglite(
  statements: readonly string[],
  options?: { readonly acquire?: number },
): Promise<DriverPool> {
  const dir = copyDir(await templateDir(statements));
  try {
    const { open } = await import("../../../src/adapters/pg/pglite.js");
    const acquire = options?.acquire;
    const pool = await open({
      dataDir: dir,
      ...(acquire !== undefined ? { timeouts: { acquire } } : {}),
    });
    const close = pool.close.bind(pool);
    return Object.assign(pool, {
      close(): Promise<void> {
        return close().finally(() => {
          rmSync(dir, { recursive: true, force: true });
        });
      },
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function templateDir(statements: readonly string[]): Promise<string> {
  const key = statements.join("\0");
  const existing = templates.get(key);
  if (existing !== undefined) return existing;
  const created = buildTemplate(statements);
  templates.set(key, created);
  return created;
}

async function buildTemplate(statements: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "okm-pglite-template-"));
  const { open } = await import("../../../src/adapters/pg/pglite.js");
  const pool = await open({ dataDir: dir });
  try {
    for (const statement of statements) await pool.execute(statement);
  } finally {
    await pool.close();
  }
  return dir;
}

function copyDir(template: string): string {
  const dir = join(tmpdir(), `okm-pglite-${crypto.randomUUID()}`);
  cpSync(template, dir, { recursive: true });
  return dir;
}
