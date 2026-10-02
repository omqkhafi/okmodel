/**
 * The one Docker skip rule for Postgres-backed tests.
 *
 * `REQUIRE_DOCKER=1` fails the test. Otherwise the test is skipped.
 */

import { expect, test } from "bun:test";

import { postgresDecision, type DockerDecision } from "./docker-gate.js";

/**
 * Probes the topology once per test file and prints the skip reason.
 *
 * @returns The decision for Postgres tests in this process
 */
export async function loadPostgresGate(): Promise<DockerDecision> {
  const decision = await postgresDecision();
  if (!decision.run) console.warn(decision.message);
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
