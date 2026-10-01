import { expect, test } from "bun:test";

import { mergeResults, renderCompatibility, type ResultsFile, type StatusRecord } from "./table.js";

const order = ["execute.rows", "execute.cancel"];

test("the compatibility table is rendered from records", () => {
  const records: StatusRecord[] = [
    {
      driver: "pglite",
      testId: "execute.cancel",
      status: "skip",
      reason: "cancel is not declared",
    },
    { driver: "postgresjs", testId: "execute.rows", status: "pass" },
    { driver: "postgresjs", testId: "execute.cancel", status: "pass" },
    { driver: "pglite", testId: "execute.rows", status: "pass" },
    { driver: "batch-mode", testId: "execute.rows", status: "pass" },
    { driver: "batch-mode", testId: "execute.cancel", status: "fail", reason: "timed out" },
  ];
  const file: ResultsFile = {
    generated: true,
    versions: { postgresjs: "17.5", pglite: "17.5", "batch-mode": "17.5" },
    records,
  };
  const markdown = renderCompatibility(file);
  expect(markdown).toContain("Generated from conformance results.");
  expect(markdown).toContain("| execute.rows | pass | pass | pass |");
  expect(markdown).toContain(
    "| execute.cancel | pass | skip: cancel is not declared | fail: timed out |",
  );
});

test("a skipped run keeps rows from drivers that did not run", () => {
  const previous: ResultsFile = {
    generated: true,
    versions: { postgresjs: "17.5" },
    records: [{ driver: "postgresjs", testId: "execute.rows", status: "pass" }],
  };
  const merged = mergeResults(
    previous,
    [{ driver: "pglite", testId: "execute.rows", status: "pass" }],
    { pglite: "17.5" },
    order,
  );
  expect(merged.records).toEqual([
    { driver: "postgresjs", testId: "execute.rows", status: "pass" },
    { driver: "pglite", testId: "execute.rows", status: "pass" },
  ]);
  expect(merged.versions.postgresjs).toBe("17.5");
});
