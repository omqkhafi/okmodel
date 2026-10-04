/**
 * Input cannot set the tenant key, whichever lane recorded it.
 *
 * `safety.property` checks the verdict again with the rules reversed.
 * Isolation on Postgres is `tenancy-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  registerTenancy,
  safetyProperty,
  verify,
  SafetyError,
  type SafetyInput,
} from "../src/runtime/safety/index.js";

const LANES = ["insert", "update", "upsert"] as const;

function line(
  how: "input" | "scoped" | "global" | "exempt" | "unscoped",
  lane: string,
): SafetyInput {
  const contribution =
    how === "input"
      ? `tenancy tasks.tenantId set by input via ${lane}`
      : how === "scoped"
        ? "tenancy scoped"
        : how === "global"
          ? "tenancy global shared reference data"
          : how === "exempt"
            ? "tenancy unique code global shared codes"
            : "tenancy unscoped nightly report";
  return {
    contributions: [{ rule: "tenancy", contribution, provenance: lane }],
  };
}

test("safety.property", () => {
  const stop = registerTenancy();
  try {
    const cases: SafetyInput[] = [];
    for (const lane of LANES) {
      cases.push(
        line("input", lane),
        line("scoped", lane),
        line("global", lane),
        line("exempt", lane),
        line("unscoped", lane),
      );
    }
    cases.push({
      ...line("input", "insert"),
      hatches: [{ name: "allow", reason: "tasks.tenantId" }],
    });
    const verdicts = safetyProperty(cases);
    for (let index = 0; index < LANES.length; index += 1) {
      const base = index * 5;
      expect(verdicts[base]?.length).toBeGreaterThan(0);
      expect(verdicts[base]?.[0]?.detail).toBe(
        "The tenant key comes from the scope. Input cannot set it.",
      );
      expect(verdicts[base + 1]).toEqual([]);
      expect(verdicts[base + 2]).toEqual([]);
      expect(verdicts[base + 3]).toEqual([]);
      expect(verdicts[base + 4]).toEqual([]);
    }
    expect(verdicts.at(-1)?.length).toBeGreaterThan(0);

    const kept = line("scoped", "insert").contributions[0];
    if (kept === undefined) throw new Error("missing contribution");
    expect(() => verify({ recorded: [kept], contributions: [] })).toThrow(SafetyError);

    fc.assert(
      fc.property(
        fc.constantFrom(...LANES),
        fc.constantFrom(
          "input" as const,
          "scoped" as const,
          "global" as const,
          "exempt" as const,
          "unscoped" as const,
        ),
        (lane, how) => {
          const [verdict] = safetyProperty([line(how, lane)]);
          expect((verdict?.length ?? 0) > 0).toBe(how === "input");
        },
      ),
    );
  } finally {
    stop();
  }
});
