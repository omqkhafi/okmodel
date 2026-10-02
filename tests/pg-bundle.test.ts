/**
 * Two column builders must not pull the rest of the dialect into a bundle.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

test("a bundle of text and integer omits the other column types", () => {
  const root = repoRoot();
  const entry = join(root, "src/dialects/pg/index.ts");
  const few = bundle(
    `import { integer, text } from ${JSON.stringify(entry)};\nexport const columns = [integer, text];\n`,
  );
  const all = bundle(`import { t } from ${JSON.stringify(entry)};\nexport const columns = t;\n`);
  expect(few.bytes).toBeLessThan(all.bytes);
  expect(few.text.includes("ltree")).toBe(false);
  expect(few.text.includes("uuidv7")).toBe(false);
  expect(few.text.includes("timestamptz")).toBe(false);
  expect(all.text.includes("ltree")).toBe(true);
  expect(all.text.includes("uuidv7")).toBe(true);
});

function bundle(source: string): { readonly bytes: number; readonly text: string } {
  const dir = mkdtempSync(join(tmpdir(), "okm-pg-"));
  const infile = join(dir, "entry.ts");
  const outfile = join(dir, "bundle.js");
  writeFileSync(infile, source);
  try {
    const proc = Bun.spawnSync(
      ["bun", "build", infile, "--minify", "--outfile", outfile, "--target", "node"],
      { cwd: repoRoot(), stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr.toString());
    }
    const text = readFileSync(outfile, "utf8");
    return { bytes: text.length, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
