/**
 * Mirror helpers for a no-op CI event.
 */

import { expect, test } from "bun:test";

import { exitCodeForConclusion, gateConclusion, priorCompletedRun } from "./ci-gate-mirror.js";

test("exitCodeForConclusion is 0 only for success", () => {
  expect(exitCodeForConclusion("success")).toBe(0);
  expect(exitCodeForConclusion("failure")).toBe(1);
  expect(exitCodeForConclusion("cancelled")).toBe(1);
  expect(exitCodeForConclusion(undefined)).toBe(1);
});

test("gateConclusion reads gate / check only", () => {
  expect(
    gateConclusion([
      { name: "lint / static", conclusion: "success" },
      { name: "gate / check", conclusion: "failure" },
    ]),
  ).toBe("failure");
  expect(gateConclusion([{ name: "lint / static", conclusion: "success" }])).toBeUndefined();
});

test("priorCompletedRun skips the current run, other workflows, and unfinished runs", () => {
  expect(
    priorCompletedRun(
      [
        { id: 3, name: "CI", status: "in_progress", conclusion: null },
        { id: 4, name: "Site", status: "completed", conclusion: "success" },
        { id: 2, name: "CI", status: "completed", conclusion: "success" },
        { id: 1, name: "CI", status: "completed", conclusion: "failure" },
      ],
      3,
    ),
  ).toEqual({ id: 2, name: "CI", status: "completed", conclusion: "success" });
  expect(
    priorCompletedRun([{ id: 9, name: "CI", status: "completed", conclusion: "success" }], 9),
  ).toBeUndefined();
});
