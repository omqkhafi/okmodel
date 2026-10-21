/**
 * `okm raw sync` and the `okm check` raw drift.
 *
 * Sync describes every static call on one direct connection and writes the
 * lock and the declaration. Check compares the source to the lock offline,
 * and re-describes when a target is selected. Neither path executes the
 * statement.
 */

import { join } from "node:path";

import { startupHash } from "../../contracts/catalog/document.js";
import type { PgTypescriptCodecs } from "../../dialects/pg/emit.js";
import type { Finding } from "../migrate/lint.js";
import type { MigrateConfig } from "../migrate/config.js";
import { projectPath } from "../migrate/paths.js";
import { assertTargetPolicy, selectTarget, type InvokeFlags } from "../migrate/policy.js";
import { loadBuiltSchema, loadConfig } from "../migrate/project.js";
import type { ProjectContext } from "../migrate/paths.js";
import { connectDescribe, DescribeError } from "./protocol.js";
import { resultFromOutcome } from "./provider.js";
import { discoverProjectRaw } from "./scan.js";
import {
  assertRawFresh,
  buildRawLock,
  commitRawArtifacts,
  offlineRawDrift,
  readRawLock,
  type RawSession,
} from "./sync.js";

/** What `okm raw sync` prints. */
export type RawSyncResult = {
  readonly lock: string;
  readonly statements: number;
  readonly unchanged: boolean;
};

/**
 * Discovers, describes, and writes the lock.
 *
 * @param project - Project directory
 * @param check - Do not write. Throw when the files would change
 * @param flags - Target, pooler, and timeouts
 * @returns The lock path and whether it already matched
 */
export async function runRawSync(
  project: string | ProjectContext,
  check: boolean,
  flags: InvokeFlags,
): Promise<RawSyncResult> {
  const cwd = typeof project === "string" ? project : project.cwd;
  const config = await loadConfig(project);
  const built = await loadBuiltSchema(cwd, config);
  const calls = discoverProjectRaw(cwd, config.raw?.include);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "check", flags.allowProtected);
  const allowPooler = flags.allowPooler || config.allowPooler === true;
  const opened = await openSession(target.url, {
    allowPooler,
    ...(flags.lockTimeoutMs !== undefined
      ? { lockTimeoutMs: flags.lockTimeoutMs }
      : config.timeouts?.lock !== undefined
        ? { lockTimeoutMs: config.timeouts.lock }
        : {}),
    ...(flags.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: flags.statementTimeoutMs }
      : config.timeouts?.statement !== undefined
        ? { statementTimeoutMs: config.timeouts.statement }
        : {}),
  });
  try {
    const lock = await buildRawLock(calls, startupHash(built.catalog), opened.session);
    const directory = projectPath(cwd, config.out ?? ".okm");
    const unchanged = commitRawArtifacts(directory, calls, lock, codecsOf(built.codecs), check);
    return {
      lock: join(config.out ?? ".okm", "raw.lock.json")
        .split("\\")
        .join("/"),
      statements: Object.keys(lock.statements).length,
      unchanged,
    };
  } finally {
    opened.close();
  }
}

/**
 * Offline raw drift for `okm check`.
 *
 * A call that is not in the lock throws OKM1604. A lock entry that is no
 * longer called is a warning.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @returns Warning findings
 */
export async function rawOfflineFindings(
  cwd: string,
  config: MigrateConfig,
): Promise<readonly Finding[]> {
  const calls = discoverProjectRaw(cwd, config.raw?.include);
  const directory = projectPath(cwd, config.out ?? ".okm");
  return offlineRawDrift(calls, readRawLock(directory));
}

/**
 * Re-describes the locked statements when a target is selected.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @param url - Direct connection URL
 * @param allowPooler - Overrides the pooler refusal
 */
export async function rawOnlineCheck(
  cwd: string,
  config: MigrateConfig,
  url: string,
  allowPooler: boolean,
): Promise<void> {
  const calls = discoverProjectRaw(cwd, config.raw?.include);
  if (calls.length === 0) return;
  const text = readRawLock(projectPath(cwd, config.out ?? ".okm"));
  if (text === undefined) return;
  const { parseLock } = await import("./lock.js");
  const opened = await openSession(url, { allowPooler });
  try {
    await assertRawFresh(calls, parseLock(text), opened.session);
  } finally {
    opened.close();
  }
}

function codecsOf(codecs: {
  readonly bigint: "string" | "number" | "bigint";
  readonly numeric: "string" | "number";
}): PgTypescriptCodecs {
  return { bigint: codecs.bigint, numeric: codecs.numeric };
}

async function openSession(
  url: string,
  options: {
    readonly allowPooler: boolean;
    readonly lockTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
  },
): Promise<{ readonly session: RawSession; readonly close: () => void }> {
  const client = await connectDescribe(url, { allowPooler: options.allowPooler });
  if (options.lockTimeoutMs !== undefined) {
    await client.query(
      `select set_config('lock_timeout', '${timeout(options.lockTimeoutMs)}', false)`,
    );
  }
  if (options.statementTimeoutMs !== undefined) {
    await client.query(
      `select set_config('statement_timeout', '${timeout(options.statementTimeoutMs)}', false)`,
    );
  }
  return {
    session: {
      describe: async (sql) => {
        const outcome = await client.describe(sql);
        if (outcome.code !== undefined) {
          throw new DescribeError(outcome.code, outcome.message ?? outcome.code);
        }
        return resultFromOutcome(outcome);
      },
      query: (sql) => client.query(sql),
    },
    close: () => {
      client.close();
    },
  };
}

function timeout(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("timeout must be a millisecond count");
  }
  return String(value);
}
