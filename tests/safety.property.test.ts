/**
 * Example for later steps. Register the rule, then pass cases to `safetyProperty`.
 *
 * A case holds when the contribution is still there, or when `.all(reason)` is
 * recorded. Removing a recorded contribution is OKM1190 `dropped`. Rule order
 * does not change the verdict.
 */

import { expect, test } from "bun:test";

import {
  SafetyError,
  registerRule,
  safetyProperty,
  verify,
  type SafetyInput,
} from "../src/runtime/safety/index.js";

const kept = {
  rule: "kept",
  contribution: "example",
  provenance: "example",
  source: "safety.property.test.ts:1",
};

test("safety.property", () => {
  const stop = registerRule({
    name: "kept",
    contribution: "example",
    check(input) {
      if (input.hatches?.some((hatch) => hatch.name === "all") === true) return [];
      const found = input.contributions.some((item) => item.rule === "kept");
      if (found) return [];
      return [
        {
          rule: "kept",
          contribution: "example",
          detail: "The example contribution is missing.",
        },
      ];
    },
  });
  const cases: readonly SafetyInput[] = [
    { contributions: [kept] },
    { contributions: [], hatches: [{ name: "all", reason: "export" }] },
    { contributions: [] },
  ];
  try {
    const verdicts = safetyProperty(cases);
    expect(verdicts[0]).toEqual([]);
    expect(verdicts[1]).toEqual([]);
    expect(verdicts[2]?.map((item) => item.rule)).toEqual(["kept"]);
    expect(() => verify({ recorded: [kept], contributions: [] })).toThrow(SafetyError);
    try {
      verify({ recorded: [kept], contributions: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyError);
      if (error instanceof SafetyError) {
        expect(error.code).toBe("OKM1190");
        expect(error.rule).toBe("dropped");
        expect(error.contribution).toBe("example");
      }
    }
  } finally {
    stop();
  }
});
