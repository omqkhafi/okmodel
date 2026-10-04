/**
 * A hidden or sensitive field cannot leak, whichever helper recorded it.
 *
 * `safety.property` checks the verdict again with the rules reversed.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  registerFieldExposure,
  safetyProperty,
  type SafetyInput,
} from "../src/runtime/safety/index.js";

const HELPERS = [
  "eq",
  "lt",
  "contains",
  "where",
  "select",
  "orderBy",
  "include",
  "filters",
  "inspect",
  "error",
] as const;

function leak(kind: "hidden" | "sensitive", helper: string): SafetyInput {
  const word = kind === "hidden" ? "shown" : "revealed";
  return {
    contributions: [
      {
        rule: kind,
        contribution: `${kind} users.passwordHash ${word} via ${helper}`,
        provenance: helper,
      },
    ],
  };
}

function safe(kind: "hidden" | "sensitive", helper: string): SafetyInput {
  const word = kind === "hidden" ? "excluded" : "redacted";
  return {
    contributions: [
      {
        rule: kind,
        contribution: `${kind} users.passwordHash ${word} via ${helper}`,
        provenance: helper,
      },
    ],
  };
}

test("safety.property", () => {
  const stop = registerFieldExposure();
  try {
    const cases: SafetyInput[] = [];
    for (const helper of HELPERS) {
      cases.push(leak("hidden", helper), safe("hidden", helper));
      cases.push(leak("sensitive", helper), safe("sensitive", helper));
    }
    cases.push({
      contributions: [
        {
          rule: "guarded",
          contribution: "guarded users.role set via update",
          provenance: "update",
        },
      ],
    });
    cases.push({
      contributions: [
        {
          rule: "guarded",
          contribution: "guarded users.role set via update",
          provenance: "update",
        },
      ],
      hatches: [{ name: "allow", reason: "users.role" }],
    });
    const verdicts = safetyProperty(cases);
    for (let index = 0; index < HELPERS.length; index += 1) {
      const base = index * 4;
      expect(verdicts[base]?.length).toBeGreaterThan(0);
      expect(verdicts[base + 1]).toEqual([]);
      expect(verdicts[base + 2]?.length).toBeGreaterThan(0);
      expect(verdicts[base + 3]).toEqual([]);
      const shown = JSON.stringify(verdicts[base]);
      expect(shown.includes("secret-value")).toBe(false);
    }
    expect(verdicts.at(-2)?.length).toBeGreaterThan(0);
    expect(verdicts.at(-1)).toEqual([]);

    fc.assert(
      fc.property(
        fc.constantFrom(...HELPERS),
        fc.constantFrom("hidden" as const, "sensitive" as const),
        fc.boolean(),
        (helper, kind, bad) => {
          const [verdict] = safetyProperty([bad ? leak(kind, helper) : safe(kind, helper)]);
          expect((verdict?.length ?? 0) > 0).toBe(bad);
          expect(JSON.stringify(verdict).includes("secret-value")).toBe(false);
        },
      ),
    );
  } finally {
    stop();
  }
});
