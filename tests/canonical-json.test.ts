/**
 * Canonical JSON for the plan hash.
 */

import { expect, test } from "bun:test";

import { sha256 } from "../src/contracts/sha256.js";
import { canonicalHash, canonicalJson } from "../src/tooling/canonical-json.js";
import { formatPlanJson, parsePlanJson } from "../src/tooling/migrate/plan-json.js";
import type { MigrationPlan } from "../src/tooling/migrate/plan.js";

test("keys sort, controls use lowercase hex, and -0 is 0", () => {
  expect(canonicalJson({ z: 1, a: "\n" })).toBe('{"a":"\\u000a","z":1}');
  expect(canonicalJson(-0)).toBe("0");
  expect(canonicalJson(1)).toBe("1");
  expect(() => canonicalJson(Number.NaN)).toThrow("non-finite");
});

test("the hash is sha256 of that text and ignores key order", () => {
  const text = canonicalJson({ b: true, a: 1 });
  expect(canonicalHash({ a: 1, b: true })).toBe(sha256(text));
  expect(canonicalHash({ b: true, a: 1 })).toBe(sha256(text));
});

test("a destructive step requires acknowledgement and hashes executed SQL", () => {
  const plan: MigrationPlan = {
    name: "drop",
    class: "contract",
    steps: [
      {
        sql: 'alter table "tasks" drop column "title"\r\n',
        class: "contract",
        kind: "drop-column",
        action: "ddl",
        lock: "ACCESS EXCLUSIVE",
        transactional: true,
        tables: ["tasks"],
      },
    ],
  };
  const document = parsePlanJson(
    formatPlanJson(plan, [], undefined, {
      dialect: "postgres",
      fromCatalogHash: "abc",
      toCatalogHash: "def",
    }),
  );
  expect(document.operationClass).toBe("destructive");
  expect(document.requiresAck).toBe(true);
  expect(document.steps[0]?.operationClass).toBe("destructive");
  expect(document.destructiveOperations[0]).toMatchObject({
    stepIndex: 0,
    kind: "drop-column",
    objectKind: "column",
    name: "tasks",
    summary: "The step is drop-column.",
  });
  const again = parsePlanJson(
    formatPlanJson(plan, [], undefined, {
      dialect: "postgres",
      fromCatalogHash: "abc",
      toCatalogHash: "def",
    }),
  );
  expect(again.planHash).toBe(document.planHash);
  expect(document.planHash).toBe(
    canonicalHash({
      planFormat: 1,
      dialect: "postgres",
      fromCatalogHash: "abc",
      toCatalogHash: "def",
      steps: [{ sql: 'alter table "tasks" drop column "title"\n', class: "destructive" }],
    }),
  );
});
