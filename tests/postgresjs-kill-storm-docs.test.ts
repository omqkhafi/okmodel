/**
 * The kill-storm repro is a real script, and the drivers page points at it.
 *
 * The warning wording is the page's. The script must stay a postgres.js-only
 * repro pinned to the postgres version this package installs.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("the drivers page points at the kill-storm repro", () => {
  const drivers = readFileSync(join(root, "site/content/docs/operate/drivers.mdx"), "utf8");
  expect(drivers).toContain("docs/postgresjs-kill-storm.md");
});

test("the kill-storm repro is postgres.js alone and pins the installed version", () => {
  const md = readFileSync(join(root, "docs/postgresjs-kill-storm.md"), "utf8");
  const script = readFileSync(join(root, "docs/postgresjs-kill-storm.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    readonly optionalDependencies?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  };
  const declared =
    pkg.optionalDependencies?.postgres ??
    pkg.dependencies?.postgres ??
    pkg.peerDependencies?.postgres ??
    pkg.devDependencies?.postgres ??
    "";
  const pinned = /\d+\.\d+\.\d+/.exec(declared)?.[0];
  if (pinned === undefined) throw new Error("package.json does not pin postgres");
  expect(md).toContain(pinned);
  expect(script).toContain('from "postgres"');
  expect(script).not.toContain("okmodel");
  expect(script).toContain("pg_terminate_backend");
});
