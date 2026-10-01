import { expect, test } from "bun:test";

import {
  assertRegistryLinked,
  CONTRACT_TESTS,
  declaredCapabilities,
  MANIFESTS,
} from "./registry.js";
import { CASE_IDS } from "./suite.js";

test("every declared capability has a conformance test", () => {
  expect(() => assertRegistryLinked(CASE_IDS)).not.toThrow();
  for (const manifest of MANIFESTS) {
    expect(declaredCapabilities(manifest).length).toBe(manifest.links.length);
  }
});

test("contract tests are registered", () => {
  for (const id of CONTRACT_TESTS) expect(CASE_IDS).toContain(id);
});
