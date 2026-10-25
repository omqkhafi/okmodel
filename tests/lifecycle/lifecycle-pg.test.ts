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
import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { OkmError } from "../../src/contracts/error.js";
import { schema, table, t } from "../../src/dialects/pg/index.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { formatLifecycleReport, knownSkipExceedsBudget, type LifecycleReport } from "./report.js";
import { runLifecycleCase } from "./run.js";
import type { ColumnModel, LifecycleCase, LifecycleCasing } from "./model.js";

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

postgresTest(
  gate,
  "random migration lifecycle keeps generate/check/apply/push invariants",
  async () => {
    if (!ENABLED) {
      console.warn("[lifecycle] skipped (set OKM_LIFECYCLE=1 to run)");
      return;
    }
    const started = Date.now();
    const report: { ran: number; passed: number; known: number; unknown: number } = {
      ran: 0,
      passed: 0,
      known: 0,
      unknown: 0,
    };
    let lastUnknown: string | undefined;
    const finish = (): LifecycleReport => report;
    try {
      await fc.assert(
        fc.asyncProperty(lifecycleCaseArb, async (item) => {
          report.ran += 1;
          const outcome = await runLifecycleCase(root, item, SEED);
          if (outcome.ok) {
            report.passed += 1;
            return true;
          }
          if (outcome.known !== undefined) {
            report.known += 1;
            console.warn(`[lifecycle] skipped known ${outcome.known}`);
            return true;
          }
          report.unknown += 1;
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
      console.log(`${formatLifecycleReport(finish())} elapsedMs=${String(elapsedMs)}`);
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
    console.log(`${formatLifecycleReport(finish())} elapsedMs=${String(elapsedMs)}`);
    if (knownSkipExceedsBudget(finish())) {
      throw new Error(`${formatLifecycleReport(finish())}: known skips are more than 25% of cases`);
    }
    if (process.env.OKM_LIFECYCLE_TIER === "pr" && elapsedMs > 240_000) {
      throw new Error(
        `PR-tier lifecycle run exceeded 4 minutes (${String(elapsedMs)} ms). Stop and ask.`,
      );
    }
  },
  Math.max(180_000, CASES * 15_000),
);

postgresTest(
  gate,
  "a snake schema and a camel schema apply, and a collision or a long name is refused",
  async () => {
    const snake = await runLifecycleCase(
      root,
      plainCase("snake", "publishedNotes", "publishedAt"),
      1,
    );
    const camel = await runLifecycleCase(
      root,
      plainCase("camel", "published_notes", "published_at"),
      2,
    );
    expect(snake.ok).toBe(true);
    expect(camel.ok).toBe(true);
    if (!snake.ok) throw new Error(snake.error);
    if (!camel.ok) throw new Error(camel.error);

    const collision = refused(() =>
      schema({
        casing: "snake",
        tables: [table("notes", { userID: t.text(), user_id: t.text() })],
      }),
    );
    expect(collision.code).toBe("OKM1023");
    const longKey = `n${"x".repeat(63)}`;
    const long = refused(() =>
      schema({
        casing: "camel",
        tables: [table("notes", { [longKey]: t.text() })],
      }),
    );
    expect(long.code).toBe("OKM1122");
    expect(Buffer.byteLength(longKey)).toBeGreaterThan(63);
  },
  180_000,
);

function plainCase(casing: LifecycleCasing, tableName: string, columnName: string): LifecycleCase {
  const column = (key: string, type: ColumnModel["type"], primaryKey: boolean): ColumnModel => ({
    key,
    name: key,
    type,
    nullable: false,
    primaryKey,
    unique: false,
    defaultKind: "none",
  });
  return {
    initial: {
      casing,
      tenancy: false,
      trgm: false,
      tables: [
        {
          key: "notes",
          name: tableName,
          columns: [column("id", "identity", true), column(columnName, "text", false)],
          indexes: [],
          checks: [],
          archive: false,
          versioned: false,
        },
      ],
      triggers: [],
      views: [],
    },
    evolutions: [],
    withRows: false,
    tags: [`casing-${casing}`],
  };
}

function refused(body: () => unknown): OkmError {
  try {
    body();
  } catch (error) {
    return OkmError.from(error);
  }
  throw new Error("expected a rejection");
}
