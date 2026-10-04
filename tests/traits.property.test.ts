/**
 * Timestamp input cannot set the clock, whichever helper recorded it.
 *
 * `safety.property` checks the verdict again with the rules reversed.
 * Insert and update on Postgres are `traits-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  registerTimestamps,
  safetyProperty,
  verify,
  SafetyError,
  type SafetyInput,
} from "../src/runtime/safety/index.js";

const FIELDS = ["createdAt", "updatedAt"] as const;
const LANES = ["insert", "update", "upsert"] as const;

function stamp(field: string, lane: string, how: "timestamps" | "input" | "kept"): SafetyInput {
  const word = how === "input" ? "set by input" : how === "kept" ? "kept" : "set by timestamps";
  return {
    contributions: [
      {
        rule: "timestamps",
        contribution: `timestamps notes.${field} ${word} via ${lane}`,
        provenance: lane,
      },
    ],
  };
}

test("safety.property", () => {
  const stop = registerTimestamps();
  try {
    const cases: SafetyInput[] = [];
    for (const field of FIELDS) {
      for (const lane of LANES) {
        cases.push(
          stamp(field, lane, "input"),
          stamp(field, lane, "timestamps"),
          stamp(field, lane, "kept"),
        );
      }
    }
    cases.push({
      ...stamp("createdAt", "insert", "input"),
      hatches: [{ name: "allow", reason: "notes.createdAt" }],
    });
    const verdicts = safetyProperty(cases);
    for (let index = 0; index < FIELDS.length * LANES.length; index += 1) {
      const base = index * 3;
      expect(verdicts[base]?.length).toBeGreaterThan(0);
      expect(verdicts[base + 1]).toEqual([]);
      expect(verdicts[base + 2]).toEqual([]);
    }
    expect(verdicts.at(-1)?.length).toBeGreaterThan(0);

    const kept = stamp("updatedAt", "update", "timestamps").contributions[0];
    if (kept === undefined) throw new Error("missing contribution");
    expect(() => verify({ recorded: [kept], contributions: [] })).toThrow(SafetyError);

    fc.assert(
      fc.property(
        fc.constantFrom(...FIELDS),
        fc.constantFrom(...LANES),
        fc.constantFrom("timestamps" as const, "input" as const, "kept" as const),
        (field, lane, how) => {
          const [verdict] = safetyProperty([stamp(field, lane, how)]);
          expect((verdict?.length ?? 0) > 0).toBe(how === "input");
        },
      ),
    );
  } finally {
    stop();
  }
});
