/**
 * Shared helpers for framework example tests.
 *
 * Boots against the repository Postgres topology. Creates an isolated
 * database, applies the notes DDL, and restores `DATABASE_URL` afterwards.
 * Links `node_modules/okmodel` to the repository root so examples resolve
 * package exports without installing the whole monorepo into each folder.
 */

import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createIsolatedDatabase, openPostgres } from "../../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../../packages/harness/src/topology.js";
import { repoRoot } from "../../scripts/root.js";

import { NOTES_DDL } from "./schema.js";

export { postgresTest, primaryUrl };

/** Gate for example tests that need Docker Postgres. */
export const gate = await loadPostgresGate();

/**
 * Symlinks `node_modules/okmodel` in an example directory to the repo root.
 *
 * @param exampleDir - Absolute path to `examples/<name>`
 */
export function linkOkmodel(exampleDir: string): void {
  const root = repoRoot();
  const linkPath = join(exampleDir, "node_modules", "okmodel");
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === root) {
      return;
    }
    rmSync(linkPath, { recursive: true, force: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  symlinkSync(root, linkPath, "dir");
}

/** An isolated database with the notes table. */
export type ExampleDatabase = {
  readonly url: string;
  close(): Promise<void>;
};

/**
 * Creates an empty database and the notes table.
 *
 * @returns The URL and a closer that drops the database
 */
export async function prepareExampleDatabase(): Promise<ExampleDatabase> {
  const isolated = await createIsolatedDatabase(primaryUrl());
  const sql = openPostgres(isolated.url);
  try {
    await sql.unsafe(NOTES_DDL);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return isolated;
}

/**
 * Runs `fn` with `DATABASE_URL` pointing at a fresh notes database.
 *
 * @param fn - Receives the database URL
 * @returns Whatever `fn` returns
 */
export async function withExampleDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const db = await prepareExampleDatabase();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = db.url;
  try {
    return await fn(db.url);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await db.close();
  }
}

/**
 * Links okmodel into the example, then runs {@link withExampleDatabase}.
 *
 * @param exampleDir - Absolute path to `examples/<name>`
 * @param fn - Receives a fresh database URL
 */
export async function withExampleApp<T>(
  exampleDir: string,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  linkOkmodel(exampleDir);
  return withExampleDatabase(fn);
}

/**
 * Waits until `url` responds or the timeout elapses.
 *
 * @param url - URL to poll
 * @param timeoutMs - Maximum wait
 */
export async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
      last = res.status;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`server did not become ready: ${String(last)}`);
}
