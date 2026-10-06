/**
 * `okm migrate status`.
 *
 * One row per target: version, catalog hash, state, and a separate protected
 * column. The state is current, behind by expand, behind by contract, ahead,
 * or failed at a step. An unfinished backfill is a later section: migration,
 * step, rows so far, last key, and state.
 */

import { join } from "node:path";

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import type { MigrationClass } from "./plan.js";
import type { StoredMigration } from "./files.js";
import { loadMigrations } from "./files.js";
import { assertTargetPolicy, listTargets, type InvokeFlags, type TargetRecord } from "./policy.js";
import { loadConfig } from "./project.js";

/** One status row. `protected` is its own column, not a state. */
export type TargetStatus = {
  readonly target: string;
  readonly version: string;
  readonly catalogHash: string;
  readonly state: string;
  readonly protected: boolean;
  /** Unfinished `okm_backfill` rows for this target. A finished step is absent. */
  readonly backfills: readonly BackfillProgress[];
};

/** One backfill that has committed at least one batch and is not done. */
export type BackfillProgress = {
  readonly migrationId: string;
  readonly stepIndex: number;
  /** Rows the committed batches changed. */
  readonly rows: string;
  /** Last committed boundary, or `-` when the first batch is still open. */
  readonly lastKey: string;
  readonly state: string;
};

/** A checkpoint row the state function reads. */
export type StatusHistory = {
  readonly migrationId: string;
  readonly stepIndex: number;
  readonly class: MigrationClass;
};

/**
 * Decides the status state from files and history.
 *
 * A partial migration is `failed at step`. History the files do not contain
 * is `ahead`. Pending files are behind by expand, or by contract when any
 * pending step is not expand.
 *
 * @param migrations - Files in apply order
 * @param history - Checkpoint rows
 * @param recorded - Head row in `okm_meta`, when the target has one
 * @returns Version, catalog hash, and state
 */
export function describeStatus(
  migrations: readonly StoredMigration[],
  history: readonly StatusHistory[],
  recorded: { readonly hash: string; readonly version: string } | undefined,
): { readonly version: string; readonly catalogHash: string; readonly state: string } {
  const done = new Set(history.map((row) => `${row.migrationId}:${String(row.stepIndex)}`));
  const known = new Set(migrations.map((migration) => migration.id));
  for (const migration of migrations) {
    let have = 0;
    let missing = -1;
    for (let index = 0; index < migration.steps.length; index += 1) {
      if (done.has(`${migration.id}:${String(index)}`)) have += 1;
      else if (missing < 0) missing = index;
    }
    if (have > 0 && missing >= 0) {
      return {
        version: migration.id,
        catalogHash: recorded?.hash ?? "-",
        state: `failed at step ${String(missing)}`,
      };
    }
  }
  const extra = history.some((row) => !known.has(row.migrationId));
  const pending = migrations.filter((migration) =>
    migration.steps.some((_, index) => !done.has(`${migration.id}:${String(index)}`)),
  );
  const finished = lastComplete(migrations, done);
  const version = recorded?.version ?? finished ?? "-";
  const catalogHash = recorded?.hash ?? "-";
  if (extra) return { version, catalogHash, state: "ahead" };
  if (pending.length > 0) {
    const contract = pending.some((migration) =>
      migration.steps.some((step) => step.class !== "expand"),
    );
    return {
      version,
      catalogHash,
      state: contract ? "behind by contract" : "behind by expand",
    };
  }
  const last = migrations.at(-1);
  if (last !== undefined && recorded !== undefined && recorded.hash !== last.catalogHash) {
    return { version, catalogHash, state: "ahead" };
  }
  return {
    version: recorded?.version ?? last?.id ?? "-",
    catalogHash: recorded?.hash ?? last?.catalogHash ?? "-",
    state: "current",
  };
}

/**
 * Reads one target and returns its status row.
 *
 * @param input - URL, name, protection, and the local migrations
 * @returns The row
 */
export async function readTargetStatus(input: {
  readonly url: string;
  readonly target: string;
  readonly protected: boolean;
  readonly searchPath?: string;
  readonly migrations: readonly StoredMigration[];
}): Promise<TargetStatus> {
  assertTargetPolicy({ name: input.target, protected: input.protected }, "status");
  const pool = open({
    url: input.url,
    max: 1,
    ...(input.searchPath !== undefined ? { searchPath: input.searchPath } : {}),
  });
  try {
    const present = await pool.execute(
      "select (to_regclass('okm_meta') is not null), (to_regclass('okm_history') is not null)",
    );
    const meta = wireTrue(present.rows[0]?.[0] ?? null);
    const history = wireTrue(present.rows[0]?.[1] ?? null);
    const recorded = meta ? await readMeta(pool) : undefined;
    const rows = history ? await readHistory(pool) : [];
    const described = describeStatus(input.migrations, rows, recorded);
    return {
      target: input.target,
      version: described.version,
      catalogHash: described.catalogHash,
      state: described.state,
      protected: input.protected,
      backfills: await readBackfills(pool),
    };
  } finally {
    await pool.close();
  }
}

/**
 * Prints status for every target, or for `--target` when it is passed.
 *
 * Several targets do not require `--target` here: the command lists them.
 *
 * @param cwd - Project directory
 * @param flags - Optional target name
 * @returns Tab-separated text, with a header
 */
export async function statusProject(cwd: string, flags: InvokeFlags): Promise<string> {
  const config = await loadConfig(cwd);
  const targets = chosen(listTargets(config), flags.target);
  const migrations = loadMigrations(join(cwd, config.migrations ?? "migrations"));
  const rows: TargetStatus[] = [];
  for (const target of targets) {
    rows.push(
      await readTargetStatus({
        url: target.url,
        target: target.name,
        protected: target.protected,
        migrations,
      }),
    );
  }
  return formatStatus(rows);
}

/**
 * Prints status rows.
 *
 * The target columns stay `target`, `version`, `catalog`, `state`, and
 * `protected`. Unfinished backfills follow as their own section.
 *
 * @param rows - One per target
 * @returns Header plus one line per target, then unfinished backfills
 */
export function formatStatus(rows: readonly TargetStatus[]): string {
  const lines = ["target\tversion\tcatalog\tstate\tprotected"];
  const backfills: BackfillProgress[] = [];
  for (const row of rows) {
    lines.push(
      [row.target, row.version, row.catalogHash, row.state, row.protected ? "true" : "false"].join(
        "\t",
      ),
    );
    backfills.push(...row.backfills);
  }
  if (backfills.length > 0) {
    lines.push("backfill");
    lines.push("migration\tstep\trows\tkey\tstate");
    for (const item of backfills) {
      lines.push(
        [item.migrationId, String(item.stepIndex), item.rows, item.lastKey, item.state].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function chosen(
  targets: readonly TargetRecord[],
  name: string | undefined,
): readonly TargetRecord[] {
  if (targets.length === 0) {
    throw new OkmError("OKM1845", "No target is configured.", {
      fix: { summary: "Set database or targets in okmodel.config.ts." },
    });
  }
  if (name === undefined) return targets;
  const found = targets.find((target) => target.name === name);
  if (found === undefined) {
    throw new OkmError("OKM1845", `Target ${name} is not configured.`, {
      fix: { summary: "Pass a name from targets." },
    });
  }
  return [found];
}

function lastComplete(
  migrations: readonly StoredMigration[],
  done: ReadonlySet<string>,
): string | undefined {
  let version: string | undefined;
  for (const migration of migrations) {
    if (migration.steps.length === 0) continue;
    const complete = migration.steps.every((_, index) =>
      done.has(`${migration.id}:${String(index)}`),
    );
    if (!complete) break;
    version = migration.id;
  }
  return version;
}

async function readMeta(pool: {
  execute: (text: string) => Promise<{ rows: readonly (readonly (string | null)[])[] }>;
}): Promise<{ hash: string; version: string } | undefined> {
  const result = await pool.execute(
    "select catalog_hash, migration_id from okm_meta where id = 'head'",
  );
  const hash = result.rows[0]?.[0];
  const version = result.rows[0]?.[1];
  if (hash === null || hash === undefined || version === null || version === undefined)
    return undefined;
  return { hash, version };
}

async function readHistory(pool: {
  execute: (text: string) => Promise<{ rows: readonly (readonly (string | null)[])[] }>;
}): Promise<StatusHistory[]> {
  const result = await pool.execute(
    "select migration_id, step_index::text, class from okm_history order by migration_id, step_index",
  );
  const rows: StatusHistory[] = [];
  for (const row of result.rows) {
    const migrationId = row[0];
    const step = row[1];
    const stepClass = row[2];
    if (migrationId == null || step == null || stepClass == null) continue;
    rows.push({
      migrationId,
      stepIndex: Number(step),
      class: stepClass === "contract" || stepClass === "unclassified" ? stepClass : "expand",
    });
  }
  return rows;
}

async function readBackfills(pool: {
  execute: (text: string) => Promise<{ rows: readonly (readonly (string | null)[])[] }>;
}): Promise<BackfillProgress[]> {
  const present = await pool.execute("select to_regclass('okm_backfill') is not null");
  if (!wireTrue(present.rows[0]?.[0] ?? null)) return [];
  const result = await pool.execute(
    `select migration_id, step_index::text, rows_touched::text, last_key, state
     from okm_backfill
     where state <> 'done'
     order by migration_id, step_index`,
  );
  const rows: BackfillProgress[] = [];
  for (const row of result.rows) {
    const migrationId = row[0];
    const step = row[1];
    const touched = row[2];
    const state = row[4];
    if (migrationId == null || step == null || touched == null || state == null) continue;
    rows.push({
      migrationId,
      stepIndex: Number(step),
      rows: touched,
      lastKey: row[3] ?? "-",
      state,
    });
  }
  return rows;
}

function wireTrue(value: string | null): boolean {
  return value === "t" || value === "true";
}
