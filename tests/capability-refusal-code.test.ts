/**
 * A refused registry entry throws its own code (N-115).
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { assertSupported } from "../src/tooling/capabilities/check.js";
import { exitCodeForCode } from "../src/tooling/cli/outcome.js";
import type { Registry } from "../src/tooling/capabilities/types.js";

const refused: Registry = {
  "type.jsonb": {
    support: "refused",
    proof: "proof:type.jsonb",
    since: "99",
    alternative: "Store the value as text.",
    code: "OKM1861",
  },
};

test("refuse uses the entry code OKM1861", () => {
  expect(() => assertSupported(["type.jsonb"], refused, "postgres")).toThrow(OkmError);
  try {
    assertSupported(["type.jsonb"], refused, "postgres");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1861");
      expect(error.message).toContain("type.jsonb");
      expect(error.fix.summary).toContain("https://okm.omqkhafi.dev/docs/reference/errors#okm1861");
    }
  }
});

test("only OKM1861 and OKM1868–OKM1879 are refusal codes", () => {
  const refuse = (code: string): OkmError => {
    try {
      assertSupported(
        ["type.jsonb"],
        {
          "type.jsonb": {
            support: "refused",
            proof: "proof:type.jsonb",
            alternative: "Store the value as text.",
            code,
          },
        },
        "postgres",
      );
    } catch (error) {
      if (error instanceof OkmError) return error;
    }
    throw new Error("expected a refusal");
  };
  expect(refuse("OKM1868").code).toBe("OKM1868");
  expect(refuse("OKM1868").fix.summary).toContain("#okm1868");
  expect(refuse("OKM1879").code).toBe("OKM1879");
  expect(refuse("OKM1879").fix.summary).toContain("#okm1879");
  expect(refuse("OKM1860").code).toBe("OKM1860");
  expect(refuse("OKM1862").code).toBe("OKM1860");
  expect(refuse("OKM1862").fix.summary).toContain("#okm1860");
  expect(refuse("OKM1867").code).toBe("OKM1860");
});

test("reserved refusal codes exit 5 and registered neighbors keep their exits", () => {
  expect(exitCodeForCode("OKM1861")).toBe(5);
  expect(exitCodeForCode("OKM1868")).toBe(5);
  expect(exitCodeForCode("OKM1879")).toBe(5);
  expect(exitCodeForCode("OKM1860")).toBe(5);
  expect(exitCodeForCode("OKM1862")).toBe(4);
});
