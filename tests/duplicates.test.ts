/**
 * Renamed copies of one function body, and a repeated large literal, are reported.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { duplicateGroups, estimateMinified } from "../scripts/duplicates.js";

const BODY = `function scoreLeft(input: string, limit: number): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code > 96 && code < 123) {
      total += code - 96;
    } else if (code >= 48 && code <= 57) {
      total += code;
    } else {
      total += 1;
    }
  }
  if (total > limit) {
    return limit;
  }
  return total;
}
`;

const RENAMED = BODY.replaceAll("scoreLeft", "scoreRight")
  .replaceAll("input", "value")
  .replaceAll("limit", "cap")
  .replaceAll("trimmed", "text")
  .replaceAll("total", "sum")
  .replaceAll("index", "cursor")
  .replaceAll("code", "unit");

const LITERAL = `export const label = "${"size-audit-".repeat(12)}";\n`;

test("estimateMinified drops whitespace and keeps string bytes", () => {
  expect(estimateMinified("const a = 1;\n")).toBe("consta=1;".length);
  expect(estimateMinified('const a = "x y";\n')).toBe('consta="x y";'.length);
});

test("a renamed function and a repeated literal are one group each", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-dup-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "left.ts"), `export ${BODY}${LITERAL}`);
  writeFileSync(join(root, "src", "right.ts"), `export ${RENAMED}${LITERAL}`);
  try {
    const groups = duplicateGroups(root);
    const functions = groups.filter((group) => group.kind === "function");
    const literals = groups.filter((group) => group.kind === "literal");
    expect(functions.length).toBeGreaterThan(0);
    const pair = functions.find((group) => group.sites.some((site) => site.file === "src/left.ts"));
    expect(pair?.sites.map((site) => site.file).sort()).toEqual(["src/left.ts", "src/right.ts"]);
    expect(pair?.minifiedBytes ?? 0).toBeGreaterThan(40);
    expect(literals).toHaveLength(1);
    expect(literals[0]?.sites.map((site) => site.file).sort()).toEqual([
      "src/left.ts",
      "src/right.ts",
    ]);
    expect(literals[0]?.minifiedBytes).toBe("size-audit-".repeat(12).length + 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
