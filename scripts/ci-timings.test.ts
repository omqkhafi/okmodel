import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SLOWEST_FILES, slowestFiles, summaryFromFile, timingsSummary } from "./ci-timings.js";

test("slowestFiles keeps the slowest version 1 entries, slowest first", () => {
  const files: Record<string, number> = {};
  for (let index = 0; index < 20; index += 1) files[`tests/f${String(index)}.test.ts`] = index;
  const rows = slowestFiles({ version: 1, files });
  expect(rows?.length).toBe(SLOWEST_FILES);
  expect(rows?.[0]).toEqual({ file: "tests/f19.test.ts", ms: 19 });
  expect(rows?.at(-1)).toEqual({ file: "tests/f5.test.ts", ms: 5 });
});

test("slowestFiles refuses a payload it does not know", () => {
  expect(slowestFiles({ version: 2, files: {} })).toBeUndefined();
  expect(slowestFiles({ version: 1, files: { a: "3" } })).toBeUndefined();
  expect(slowestFiles({ files: { a: 1 } })).toBeUndefined();
  expect(slowestFiles(null)).toBeUndefined();
});

test("the summary is a table, and an unreadable file says why", () => {
  expect(timingsSummary("test / client", [{ file: "tests/a.test.ts", ms: 1234 }])).toBe(
    "### Slowest test files: test / client\n\n| File | Seconds |\n| --- | ---: |\n| `tests/a.test.ts` | 1.2 |\n",
  );
  const dir = mkdtempSync(join(tmpdir(), "okm-timings-"));
  try {
    expect(summaryFromFile(join(dir, "missing.json"), "job")).toContain("no timings file.");
    writeFileSync(join(dir, "bad.json"), "{");
    expect(summaryFromFile(join(dir, "bad.json"), "job")).toContain("not JSON.");
    writeFileSync(join(dir, "v2.json"), JSON.stringify({ version: 2, files: {} }));
    expect(summaryFromFile(join(dir, "v2.json"), "job")).toContain("not Bun version 1.");
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ version: 1, files: { "t.test.ts": 5 } }));
    expect(summaryFromFile(join(dir, "ok.json"), "job")).toContain("| `t.test.ts` | 0.0 |");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
