/**
 * The Postgres registry matches the suite, and a refused fixture fails the build.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { OkmError } from "../src/contracts/error.js";
import {
  assertSupported,
  collectTestTitles,
  formatEmulation,
  POSTGRES_FEATURES,
  registryProblems,
  type Registry,
} from "../src/tooling/capabilities/index.js";

const titles = collectTestTitles([join(repoRoot(), "tests"), join(repoRoot(), "packages/harness")]);

const fixture: Registry = {
  "fixture.refused": {
    support: "refused",
    since: "99",
    alternative: "Use schema.core.",
    code: "OKM1860",
    proof: "proof:fixture.refused",
  },
};

test("proof:fixture.refused", () => {
  expect(fixture["fixture.refused"]?.support).toBe("refused");
  expect(fixture["fixture.refused"]?.alternative).toBe("Use schema.core.");
});

test("refusal:fixture.refused", () => {
  let caught: unknown;
  try {
    assertSupported(["fixture.refused"], fixture, "postgres");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  if (!(caught instanceof OkmError)) return;
  expect(caught.code).toBe("OKM1860");
  expect(caught.message).toBe("postgres refuses fixture.refused. First supported in 99.");
  expect(caught.fix.summary).toContain("Use schema.core.");
  expect(caught.fix.summary).toContain("https://okm.omqkhafi.dev/docs/reference/errors#okm1860");
  expect(caught.message.toLowerCase()).not.toContain("bypass");
  expect(caught.fix.summary.toLowerCase()).not.toContain("bypass");
});

test("the postgres registry proofs are literal test titles", () => {
  expect(registryProblems(POSTGRES_FEATURES, titles)).toEqual([]);
});

test("a registry entry without a proof fails", () => {
  const broken: Registry = {
    "schema.core": { support: "native", proof: "proof:missing" },
  };
  expect(registryProblems(broken, titles).join("\n")).toContain("proof:missing");
});

test("a refused entry without a refusal test fails", () => {
  const broken: Registry = {
    "fixture.orphan": {
      support: "refused",
      alternative: "Use schema.core.",
      code: "OKM1860",
      proof: "proof:fixture.refused",
    },
  };
  expect(registryProblems(broken, titles).join("\n")).toContain("refusal:fixture.orphan");
});

test("the fixture refusal is still refused", () => {
  expect(registryProblems(fixture, titles)).toEqual([]);
});

test("an emulated feature passes with its cost line", () => {
  const emulated: Registry = {
    "type.demo": { support: "emulated", cost: "one extra read", proof: "proof:fixture.refused" },
  };
  expect(formatEmulation(assertSupported(["type.demo"], emulated, "postgres"))).toBe(
    "emulated type.demo: one extra read\n",
  );
});

test("OKM1860 has a tested docs page", () => {
  const page = readFileSync(join(repoRoot(), "site/content/docs/reference/errors.mdx"), "utf8");
  expect(page).toContain("`OKM1860`");
  expect(page).toContain("Feature refused");
  expect(page).toContain("portable alternative");
});
