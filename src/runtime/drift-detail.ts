/**
 * Compatibility check used only when the catalog hashes differ.
 *
 * Ahead by expand is compatible. Ahead by a contract step, or behind, fails
 * closed (OKM1520). The class is the value stored in `okm_history`.
 */

import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { AHEAD_CONTRACT, BEHIND_CONTRACT, BEHIND_EXPAND } from "./compat-words.js";

/** One applied migration, in history order. */
export type DriftMigration = {
  readonly id: string;
  readonly catalogHash: string;
  /** True when every stored step class is `expand`. */
  readonly expand: boolean;
};

/** How far the database and the app have diverged. */
export type DriftVerdict =
  | { readonly state: "ok" }
  | { readonly state: "ahead by contract"; readonly migrationId: string }
  | { readonly state: "behind by expand"; readonly migrationId: string }
  | { readonly state: "behind by contract"; readonly migrationId: string }
  | { readonly state: "behind"; readonly migrationId: string };

/**
 * Classifies a hash mismatch from stored history classes.
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
): DriftVerdict {
  const codeAt = indexOfHash(migrations, codeHash);
  const recordedAt = indexOfHash(migrations, recordedHash);
  if (codeAt >= 0 && recordedAt >= codeAt) {
    for (let index = codeAt + 1; index <= recordedAt; index += 1) {
      const migration = migrations[index];
      if (migration !== undefined && migration.expand !== true) {
        return { state: "ahead by contract", migrationId: migration.id };
      }
    }
    return { state: "ok" };
  }
  if (codeAt >= 0 && recordedAt >= 0 && recordedAt < codeAt) {
    const next = migrations[recordedAt + 1];
    if (next !== undefined) {
      return {
        state: next.expand ? "behind by expand" : "behind by contract",
        migrationId: next.id,
      };
    }
  }
  if (recordedAt >= 0) {
    const at = migrations[recordedAt];
    if (at !== undefined) return { state: "behind", migrationId: at.id };
  }
  const last = migrations.at(-1);
  return { state: "behind", migrationId: last?.id ?? "" };
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
    throw gapError({ state: "behind", migrationId: "" }, error);
  }
  const verdict = driftVerdict(codeHash, recordedHash, groupMigrations(rows));
  if (verdict.state === "ok") return;
  throw gapError(verdict);
}

function indexOfHash(migrations: readonly DriftMigration[], hash: string): number {
  let found = -1;
  for (let index = 0; index < migrations.length; index += 1) {
    if (migrations[index]?.catalogHash === hash) found = index;
  }
  return found;
}

/**
 * Groups history rows. `expand` is false when any stored class is not expand.
 *
 * The class column is used as stored. Nothing plans the SQL again.
 */
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

function gapError(
  verdict: Exclude<DriftVerdict, { readonly state: "ok" }>,
  cause?: unknown,
): OkmError {
  const named = verdict.migrationId;
  const phrase =
    verdict.state === "ahead by contract"
      ? `${AHEAD_CONTRACT} migration ${named}`
      : verdict.state === "behind by expand"
        ? `${BEHIND_EXPAND} migration ${named}`
        : verdict.state === "behind by contract"
          ? `${BEHIND_CONTRACT} migration ${named}`
          : named.length > 0
            ? `behind the app at migration ${named}`
            : "behind the app";
  const fix =
    named.length > 0
      ? `Apply ${named}, or change the deploy order.`
      : "Apply migrations, or change the deploy order.";
  return new OkmError("OKM1520", `The database is ${phrase}.`, {
    ...(cause === undefined ? {} : { cause }),
    fix: { summary: fix },
  });
}
