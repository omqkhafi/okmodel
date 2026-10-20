/**
 * Every capability flag has a reader.
 *
 * A runtime read counts. A registry `gate` counts only together with a
 * conformance test that reads the same flag.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";

function sources(directory: string, skip: readonly string[]): string {
  let text = "";
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (skip.includes(path)) continue;
    const info = statSync(path);
    if (info.isDirectory()) {
      text += sources(path, skip);
      continue;
    }
    if (name.endsWith(".ts")) text += `\n${readFileSync(path, "utf8")}`;
  }
  return text;
}

test("every capability flag has a code consumer", () => {
  const root = repoRoot();
  const runtime = sources(join(root, "src/runtime"), []);
  const adapters = sources(join(root, "src/adapters"), [
    join(root, "src/adapters/capabilities.ts"),
  ]);
  const harness = readFileSync(join(root, "packages/harness/src/driver-suite.ts"), "utf8");
  const product = `${runtime}\n${adapters}`;
  const unread: string[] = [];
  for (const name of Object.keys(POSTGRESJS_CAPABILITIES)) {
    const read = product.includes(`capabilities.${name}`);
    const gated = Object.values(POSTGRES_FEATURES).some((entry) => entry.gate === name);
    const conformance = harness.includes(`capabilities.${name}`);
    if (!read && !(gated && conformance)) unread.push(name);
  }
  expect(unread).toEqual([]);
});
