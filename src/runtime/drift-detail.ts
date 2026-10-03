/**
 * Compatibility check used only when the catalog hashes differ.
 *
 * Ahead by expand is compatible. Ahead by a contract step, or behind, fails
 * closed (OKM1520).
 */

import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";

/** One applied migration, in history order. */
export type DriftMigration = {
  readonly id: string;
  readonly catalogHash: string;
  /** True when every step is expand. */
  readonly expand: boolean;
};

/**
 * Classifies a hash mismatch.
 *
 * @param codeHash - Hash of the code's catalog
 * @param recordedHash - Hash stored in `okm_meta`
 * @param migrations - Applied migrations, oldest first
 * @returns `ok` when the database is ahead by expand only
 */
export function driftVerdict(
  codeHash: string,
  recordedHash: string,
  migrations: readonly DriftMigration[],
): "ok" | "behind" | "contract" {
  const codeAt = indexOfHash(migrations, codeHash);
  const recordedAt = indexOfHash(migrations, recordedHash);
  if (codeAt < 0 || recordedAt < 0 || recordedAt < codeAt) return "behind";
  if (recordedAt === codeAt) return "ok";
  for (let index = codeAt + 1; index <= recordedAt; index += 1) {
    if (migrations[index]?.expand !== true) return "contract";
  }
  return "ok";
}

/**
 * Reads history and throws OKM1520 when the database is not expand-ahead.
 *
 * @param pool - The connection `connect` already opened
 * @param codeHash - Hash of the code's catalog
 * @param recordedHash - Hash from the startup query
 * @param options - The call's cancellation and deadline
 */
export async function assertDrift(
  pool: DriverPool,
  codeHash: string,
  recordedHash: string,
  options: ExecuteOptions | undefined,
): Promise<void> {
  let rows: readonly (readonly (string | null)[])[];
  try {
    const result = await pool.execute(
      "select migration_id, class, catalog_hash from okm_history order by migration_id, step_index",
      undefined,
      options,
    );
    rows = result.rows;
  } catch (error) {
    throw behind(error);
  }
  const verdict = driftVerdict(codeHash, recordedHash, groupMigrations(rows));
  if (verdict === "ok") return;
  if (verdict === "contract") {
    throw new OkmError("OKM1520", "The database is ahead of the code by a contract migration.", {
      fix: {
        summary:
          "Roll the application forward, or repair the database. A contract step is not compatible with this code.",
      },
    });
  }
  throw behind(undefined);
}

function indexOfHash(migrations: readonly DriftMigration[], hash: string): number {
  let found = -1;
  for (let index = 0; index < migrations.length; index += 1) {
    if (migrations[index]?.catalogHash === hash) found = index;
  }
  return found;
}

function groupMigrations(rows: readonly (readonly (string | null)[])[]): DriftMigration[] {
  const grouped: DriftMigration[] = [];
  for (const row of rows) {
    const id = row[0];
    const stepClass = row[1];
    const hash = row[2];
    if (id == null || stepClass == null || hash == null) continue;
    const expand = stepClass === "expand";
    const last = grouped.at(-1);
    if (last !== undefined && last.id === id) {
      grouped[grouped.length - 1] = {
        id,
        catalogHash: hash,
        expand: last.expand && expand,
      };
      continue;
    }
    grouped.push({ id, catalogHash: hash, expand });
  }
  return grouped;
}

function behind(cause: unknown): OkmError {
  return new OkmError("OKM1520", "The database is behind the code.", {
    ...(cause === undefined ? {} : { cause }),
    fix: {
      summary:
        "Inspect the diff and repair the database, or generate a migration that matches the drift.",
    },
  });
}
