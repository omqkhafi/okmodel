/**
 * Property: the migrate / push CLI contract holds over random schemas.
 *
 * PR tier: fixed seed, ~20 cases (`OKM_LIFECYCLE_CASES`, default 20).
 * Nightly: 300 cases and a printed random seed when `OKM_LIFECYCLE_SEED` is unset
 * and `OKM_LIFECYCLE_CASES=300`.
 *
 * Only runs when `OKM_LIFECYCLE=1` so the ordinary Postgres suite stays fast.
 * Known open bugs are skipped by id; anything else fails with a copyable schema.
 */

import fc from "fast-check";

import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { runLifecycleCase } from "./run.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const ENABLED = process.env.OKM_LIFECYCLE === "1";
const CASES = Math.max(1, Number(process.env.OKM_LIFECYCLE_CASES ?? "20"));
const SEED = Number(
  process.env.OKM_LIFECYCLE_SEED ??
    (process.env.OKM_LIFECYCLE_RANDOM === "1"
      ? String((Math.random() * 0x100000000) >>> 0)
      : "20261024"),
);

if (ENABLED) {
  console.log(
    `[lifecycle] seed=${String(SEED)} cases=${String(CASES)} (set OKM_LIFECYCLE_SEED to replay)`,
  );
}

const skippedKnown = new Map<string, number>();

postgresTest(
  gate,
  "random migration lifecycle keeps generate/check/apply/push invariants",
  async () => {
    if (!ENABLED) {
      console.warn("[lifecycle] skipped (set OKM_LIFECYCLE=1 to run)");
      return;
    }
    const started = Date.now();
    let lastUnknown: string | undefined;
    try {
      await fc.assert(
        fc.asyncProperty(lifecycleCaseArb, async (item) => {
          const outcome = await runLifecycleCase(root, item, SEED);
          if (outcome.ok) return true;
          if (outcome.known !== undefined) {
            skippedKnown.set(outcome.known, (skippedKnown.get(outcome.known) ?? 0) + 1);
            console.warn(`[lifecycle] skipped known ${outcome.known}`);
            return true;
          }
          lastUnknown = outcome.error;
          // Throw so fast-check shrinks against the real message and the report
          // includes the copyable schema.
          throw new Error(outcome.error);
        }),
        {
          seed: SEED,
          numRuns: CASES,
          verbose: fc.VerbosityLevel.None,
          // Allow shrinks; stop early once a minimal unknown failure is in hand.
          endOnFailure: true,
          // Prefer structured shrink of the case over a long error string.
          includeErrorInReport: true,
        },
      );
    } catch (error) {
      const elapsedMs = Date.now() - started;
      console.log(
        `[lifecycle] cases=${String(CASES)} elapsedMs=${String(elapsedMs)} knownSkipped=${JSON.stringify(Object.fromEntries(skippedKnown))}`,
      );
      if (lastUnknown !== undefined) {
        const lines = lastUnknown.split("\n").length;
        if (lines > 15) {
          throw new Error(
            `Lifecycle failure repro is ${String(lines)} lines (>15). Stop and ask.\n\n${lastUnknown}`,
          );
        }
      }
      throw error;
    }
    const elapsedMs = Date.now() - started;
    console.log(
      `[lifecycle] cases=${String(CASES)} elapsedMs=${String(elapsedMs)} knownSkipped=${JSON.stringify(Object.fromEntries(skippedKnown))}`,
    );
    if (process.env.OKM_LIFECYCLE_TIER === "pr" && elapsedMs > 240_000) {
      throw new Error(
        `PR-tier lifecycle run exceeded 4 minutes (${String(elapsedMs)} ms). Stop and ask.`,
      );
    }
  },
  Math.max(180_000, CASES * 15_000),
);
