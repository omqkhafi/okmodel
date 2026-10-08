/**
 * The one Docker skip rule for Postgres-backed tests.
 *
 * `REQUIRE_DOCKER=1` fails the test. Otherwise the test is skipped.
 */

import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";

import { postgresDecision, type DockerDecision } from "./docker-gate.js";

/**
 * Probes the topology once per test file and prints the skip reason.
 *
 * Under `CI=true` a missing database fails the file instead of skipping it,
 * so CI can never go green on vacuous Postgres skips.
 *
 * @returns The decision for Postgres tests in this process
 */
export async function loadPostgresGate(): Promise<DockerDecision> {
  const decision = await postgresDecision();
  if (decision.run) return decision;
  if (process.env.CI === "true") {
    throw new Error(`${decision.message} Failing because CI=true: a Postgres suite with no database must be red, not skipped.`);
  }
  console.warn(decision.message);
  return decision;
}

/**
 * Registers a Postgres test, skipping it when Docker is down and failing it when required.
 *
 * @param decision - Result of {@link loadPostgresGate}
 * @param name - Test name
 * @param fn - Test body
 * @param timeoutMs - Test timeout. The default matches Bun's limit
 */
/** Env var naming the file that counts skipped Postgres tests. Set by the suite runner. */
const SKIP_COUNT_FILE_ENV = "OKM_POSTGRES_SKIP_FILE";

/**
 * Counts one skipped Postgres test.
 *
 * `bun test` never runs `process.on("exit")` hooks, so the count cannot be
 * printed from this process. Each skip appends one byte to the file named by
 * `OKM_POSTGRES_SKIP_FILE`; the suite runner prints `N Postgres tests
 * SKIPPED` from it after the run, so a database-less run is loud instead of
 * silently green. Without the env var nothing is written.
 */
function notePostgresSkip(): void {
  const path = process.env[SKIP_COUNT_FILE_ENV];
  if (path === undefined || path === "") return;
  try {
    appendFileSync(path, "\n");
  } catch {
    // The counter is best-effort; a missing file must not fail a test run.
  }
}

export function postgresTest(
  decision: DockerDecision,
  name: string,
  fn: () => Promise<void>,
  timeoutMs = 5_000,
): void {
  if (decision.run) {
    test(name, fn, { timeout: timeoutMs });
    return;
  }
  if (decision.fail) {
    test(name, () => {
      throw new Error(decision.message);
    });
    return;
  }
  notePostgresSkip();
  test.skip(name, fn);
}

/**
 * Fails the file when `REQUIRE_DOCKER=1` and the topology is not reachable.
 *
 * @param decision - Result of {@link loadPostgresGate}
 */
export function requirePostgresWhenAsked(decision: DockerDecision): void {
  if (process.env.REQUIRE_DOCKER !== "1") return;
  test("postgres topology is reachable", () => {
    expect(decision.run).toBe(true);
  });
}
