/**
 * postgres-suite — R2 preflight probe and skip counter.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postgresReachable, readSkipCount } from "./postgres-suite.js";

describe("R2 postgresReachable", () => {
  test("a refused port is not reachable", async () => {
    expect(await postgresReachable("postgres://okm:okm@127.0.0.1:1/okm")).toBe(false);
  });

  test("a malformed URL is not reachable", async () => {
    expect(await postgresReachable("not a url")).toBe(false);
  });
});

describe("R2 readSkipCount", () => {
  test("counts one skip per appended byte and misses nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "okm-r2-test-"));
    try {
      const path = join(dir, "skips");
      writeFileSync(path, "\n".repeat(13));
      expect(readSkipCount(path)).toBe(13);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing counter file reads as zero", () => {
    expect(readSkipCount(join(tmpdir(), "okm-r2-test-missing", "skips"))).toBe(0);
  });
});
