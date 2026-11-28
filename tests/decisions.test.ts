/**
 * Decision files: headers, continuity, supersedes links, the index, and src citations.
 */

import { expect, test } from "bun:test";

import {
  HISTORICAL_IDS,
  indexProblems,
  loadDecisionRecords,
  nextDecisionId,
  parseDecisionFile,
  parseLegacyDecisions,
  recordsFromLegacy,
  renderDecision,
  rulesProblems,
  sourceCitationProblems,
  structureProblems,
} from "../scripts/decisions.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("legacy rows keep the decision cell, including an unescaped pipe", () => {
  const text = [
    "| D1 | Alpha | See [plan](okmodel-execution-plan.md). |",
    "| D2 | Beta | Supersedes D1. typed `| undefined` stays |",
    "| Driver | Endpoint | Pass |",
  ].join("\n");
  const parsed = parseLegacyDecisions(text);
  expect(parsed.problems).toEqual([]);
  expect(parsed.rows.map((row) => row.id)).toEqual(["D1", "D2"]);
  const built = recordsFromLegacy(parsed.rows);
  expect(built.problems).toEqual([]);
  const first = built.records[0];
  const second = built.records[1];
  expect(first?.body).toBe("See [plan](../okmodel-execution-plan.md).");
  expect(first?.status).toEqual({ kind: "superseded", by: "D2" });
  expect(second?.supersedes).toEqual(["D1"]);
  expect(second?.body).toBe("Supersedes D1. typed `| undefined` stays");
});

test("a rendered decision file parses back to the same record", () => {
  const record = {
    id: "D9",
    title: "Example",
    status: { kind: "accepted" as const },
    areas: ["product" as const],
    supersedes: [],
    body: "The cell text.",
  };
  const parsed = parseDecisionFile(renderDecision(record), "D9.md");
  expect(parsed.problems).toEqual([]);
  expect(parsed.record).toEqual(record);
});

test("decision files parse, numbers are continuous, and supersedes links resolve", () => {
  const loaded = loadDecisionRecords(root);
  expect(loaded.problems).toEqual([]);
  expect(structureProblems(loaded.records)).toEqual([]);
  expect(loaded.records.some((record) => record.id === "D16a")).toBe(true);
  expect(nextDecisionId(loaded.records.map((record) => record.id))).toBe("D363");
  const byId = new Map(loaded.records.map((record) => [record.id, record]));
  expect(byId.get("D25")?.status).toEqual({ kind: "superseded", by: "D120" });
  expect(byId.get("D67")?.status).toEqual({ kind: "superseded", by: "D91" });
  expect(byId.get("D120")?.supersedes).toEqual(["D25"]);
  expect(byId.get("D91")?.supersedes).toEqual(["D67"]);
  for (const id of HISTORICAL_IDS) {
    expect(byId.get(id)?.status.kind).toBe("historical");
  }
  expect(byId.get("D206")?.body).toContain("Current status:");
  expect(byId.get("D212")?.body).toContain("Current status:");
});

test("the index matches the generator and rules cite live decisions", () => {
  const loaded = loadDecisionRecords(root);
  expect(loaded.problems).toEqual([]);
  expect(indexProblems(root, loaded.records)).toEqual([]);
  expect(rulesProblems(root, loaded.records)).toEqual([]);
});

test("every decision cited from src exists", () => {
  const loaded = loadDecisionRecords(root);
  expect(loaded.problems).toEqual([]);
  expect(sourceCitationProblems(root, loaded.records)).toEqual([]);
});
