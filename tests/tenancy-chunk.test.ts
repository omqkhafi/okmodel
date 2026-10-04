/**
 * A missing lazy chunk fails the call. It does not run a statement without the predicate.
 *
 * The import failure runs in a child process so the mock cannot reach the rest of the suite.
 */

import { expect, test } from "bun:test";

import { compileCall } from "../src/runtime/plan.js";
import { app, TASK, TENANT_A } from "./tenancy-schema.js";

test("the planner keeps the predicate and refuses an include without its chunk", () => {
  const plan = compileCall(
    app,
    { op: "find", table: "tasks", where: { id: TASK }, limit: 1, scope: { value: TENANT_A } },
    "key",
  );
  expect(plan.text).toContain('"tenant_id" = ');
  expect(() =>
    compileCall(
      app,
      {
        op: "find",
        table: "tasks",
        limit: 1,
        include: { org: true },
        scope: { value: TENANT_A },
      },
      "include",
    ),
  ).toThrow(/include planner/);
});

test("a failed include or write import rejects before a query runs", async () => {
  const proc = Bun.spawn(["bun", "tests/tenancy-chunk.worker.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
