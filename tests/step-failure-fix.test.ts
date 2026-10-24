/**
 * A lock timeout and any other step failure get different advice.
 */

import { expect, test } from "bun:test";

import { stepFailureFix } from "../src/tooling/migrate/runner.js";

test("a lock timeout names the command that should run again", () => {
  const error = Object.assign(new Error("canceling statement due to lock timeout"), {
    sqlstate: "55P03",
  });
  expect(stepFailureFix(error, "check").summary).toBe(
    "A lock timed out. Run okm migrate check again when that lock is free. The step does not need a change.",
  );
  expect(stepFailureFix(error, "apply").summary).toBe(
    "A lock timed out. Run okm migrate apply again when that lock is free. Finished steps are not repeated.",
  );
});

test("any other step failure still says to fix the step and run apply", () => {
  expect(stepFailureFix(new Error("syntax error"), "check").summary).toBe(
    "Fix the step and run apply again. Finished steps are not repeated.",
  );
});
