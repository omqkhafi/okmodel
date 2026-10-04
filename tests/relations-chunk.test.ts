/**
 * A missing lazy chunk fails the call. It never runs a statement without the
 * tenant and active-set predicates.
 *
 * The import failure runs in a child process so the mock cannot reach the rest of the suite.
 */

import { expect, test } from "bun:test";

import { has } from "../src/dialects/pg/index.js";
import { compileCall } from "../src/runtime/plan.js";
import { app, TENANT_A } from "./relations-schema.js";

test("a manyThrough filter plans with the tenant and active-set predicates on both tables", () => {
  const plan = compileCall(
    app,
    {
      op: "find",
      table: "tasks",
      where: { labels: has({ name: "x" }) },
      limit: 1,
      scope: { value: TENANT_A },
    },
    "through",
  );
  const text = plan.text;
  // Join table `jr0_labels` and target `r0_labels` each carry both predicates.
  for (const alias of ["jr0_labels", "r0_labels"]) {
    expect(text).toContain(`${alias}."tenant_id" = $`);
    expect(text).toContain(`${alias}."archived_at" is null`);
  }
});

test("a failed page or aggregate import rejects before a query runs", async () => {
  const proc = Bun.spawn(["bun", "tests/relations-chunk.worker.ts"], {
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
