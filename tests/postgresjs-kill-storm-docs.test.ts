/**
 * Honesty gates for B-02: postgres.js kill-storm uncaught is upstream.
 *
 * Fails if the known-limits entry, Drivers page, or minimal repro disappear.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("known-limits documents postgres.js kill-storm as upstream (B-02)", () => {
  const limits = readFileSync(join(root, "docs/known-limits.md"), "utf8");
  expect(limits).toContain("postgres.js raises uncaught exceptions under a backend kill storm");
  expect(limits).toContain("B-02, upstream");
  expect(limits).toContain("postgres.js 3.4.9 alone");
  expect(limits).toContain("Prefer `okmodel/pg/pg` or `okmodel/pg/bun`");
  expect(limits).toContain("postgresjs-kill-storm.md");
  expect(limits).toContain("is not a fix");
});

test("Drivers page warns about postgres.js kill storms (B-02)", () => {
  const drivers = readFileSync(join(root, "site/content/docs/operate/drivers.mdx"), "utf8");
  expect(drivers).toContain("postgres.js kill storms (B-02)");
  expect(drivers).toContain("Prefer `okmodel/pg/pg` or `okmodel/pg/bun`");
  expect(drivers).toContain("docs/postgresjs-kill-storm.md");
});

test("minimal postgres.js kill-storm repro exists and pins 3.4.9", () => {
  const md = readFileSync(join(root, "docs/postgresjs-kill-storm.md"), "utf8");
  const script = readFileSync(join(root, "docs/postgresjs-kill-storm.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    readonly optionalDependencies?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  };
  const version =
    pkg.optionalDependencies?.postgres ??
    pkg.dependencies?.postgres ??
    pkg.peerDependencies?.postgres ??
    pkg.devDependencies?.postgres ??
    "";
  expect(md).toContain("Upstream");
  expect(md).toContain("3.4.9");
  expect(md).toContain("no OKModel");
  expect(md).toContain("Prefer `okmodel/pg/pg` or `okmodel/pg/bun`");
  expect(script).toContain('from "postgres"');
  expect(script).not.toContain("okmodel");
  expect(script).toContain("pg_terminate_backend");
  expect(version).toMatch(/3\.4\.9/);
});
