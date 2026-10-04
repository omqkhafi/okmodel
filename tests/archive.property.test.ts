/**
 * The active set and the cascade contract hold whichever way the rules run.
 *
 * `safety.property` checks the verdict again with the rules reversed.
 * Row sequences on Postgres are `archive-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  registerArchive,
  SafetyError,
  safetyProperty,
  verify,
  type SafetyInput,
} from "../src/runtime/safety/index.js";

const LINES = ["active set", "with archived", "only archived", "cascade tasks"] as const;

function line(
  phrase: (typeof LINES)[number] | "active set dropped" | "cascade skipped",
): SafetyInput {
  return {
    contributions: [{ rule: "archive", contribution: phrase, provenance: "planner" }],
  };
}

test("safety.property", () => {
  const stop = registerArchive();
  try {
    const cases = [
      line("active set"),
      line("with archived"),
      line("only archived"),
      line("cascade tasks"),
      line("active set dropped"),
      line("cascade skipped"),
    ];
    const verdicts = safetyProperty(cases);
    expect(verdicts[0]).toEqual([]);
    expect(verdicts[1]).toEqual([]);
    expect(verdicts[2]).toEqual([]);
    expect(verdicts[3]).toEqual([]);
    expect(verdicts[4]?.[0]?.detail).toBe("Reads, updates, and deletes target the active set.");
    expect(verdicts[5]?.[0]?.detail).toBe(
      "Cascade archives and restores the named children with the row.",
    );

    const kept = line("active set").contributions[0];
    if (kept === undefined) throw new Error("missing contribution");
    expect(() => verify({ recorded: [kept], contributions: [] })).toThrow(SafetyError);

    fc.assert(
      fc.property(fc.constantFrom(...LINES, "active set dropped", "cascade skipped"), (phrase) => {
        const [verdict] = safetyProperty([line(phrase)]);
        const broken = phrase === "active set dropped" || phrase === "cascade skipped";
        expect((verdict?.length ?? 0) > 0).toBe(broken);
      }),
    );
  } finally {
    stop();
  }
});
