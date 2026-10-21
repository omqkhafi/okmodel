/**
 * Every command declares what it does with text it did not write.
 */

import { expect, test } from "bun:test";

import { COMMANDS } from "../src/tooling/cli/spec.js";
import { UNTRUSTED_ORIGINS } from "../src/tooling/untrusted.js";
import { UNTRUSTED_PATHS } from "../src/tooling/untrusted-paths.js";

test("every command is listed, and an object path names a closed origin", () => {
  const listed = new Set(UNTRUSTED_PATHS.map((path) => path.command));
  const missing = COMMANDS.map((command) => command.id).filter((id) => !listed.has(id));
  expect(missing).toEqual([]);
  for (const path of UNTRUSTED_PATHS) {
    if (path.treatment !== "object") continue;
    const origin = path.origin;
    if (origin === undefined) throw new Error(path.path);
    expect(UNTRUSTED_ORIGINS).toContain(origin);
  }
});
