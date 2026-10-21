/**
 * Public docs: classification, front matter, fences, hidden characters, pack size.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { BUMP_OUTPUTS } from "../scripts/bump-version.js";
import {
  classificationProblems,
  committedDocVersion,
  docClass,
  restorePackedDocs,
  stampDocText,
  stampPackedDocs,
} from "../scripts/docs-pack.js";
import { INDEX_CAP, renderDocsIndex } from "../scripts/docs-index.js";
import {
  fenceProblems,
  frontMatterProblems,
  hiddenCharsIn,
  hygieneProblems,
  internalLinkProblems,
} from "../scripts/docs-hygiene.js";
import { PACK_SIZE_LIMIT, packSizeProblems } from "../scripts/pack-size.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("every docs file is public or internal, and the repository is clean", () => {
  expect(docClass("guide.md")).toBe("public");
  expect(docClass("size.md")).toBe("internal");
  expect(docClass("errors/OKM1012.md")).toBe("public");
  expect(docClass("errors/README.md")).toBeUndefined();
  expect(docClass("capabilities.md")).toBe("public");
  expect(classificationProblems(root)).toEqual([]);
  expect(hygieneProblems(root, "0.10.0-next.47")).toEqual([]);
});

test("the index is the train version, under 8 KB, and bump does not list docs", () => {
  expect(committedDocVersion("0.10.0-next.47")).toBe("0.10.0");
  expect(committedDocVersion("0.10.0")).toBe("0.10.0");
  const index = renderDocsIndex("0.10.0-next.47");
  expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(INDEX_CAP);
  expect(index).toContain("OKModel 0.10.0 - agent index\n");
  expect(index).not.toContain("-next.");
  expect(index).toContain("docs/errors/<code>.md");
  expect(index).toContain("`okm migrate apply`");
  expect(readFileSync(join(root, "docs/index.md"), "utf8")).toBe(index);
  expect([...BUMP_OUTPUTS]).toEqual(["package.json", "changelog.md"]);
});

test("front matter, fences, and internal URLs are reported", () => {
  expect(frontMatterProblems("# Title\n", "docs/x.md")).toEqual([
    "docs/x.md: missing front matter",
  ]);
  const page = [
    "---",
    'okmVersion: "0.10.0"',
    'since: "0.9"',
    "dialects: [postgres]",
    "codes: []",
    "---",
    "# Title",
    "",
  ].join("\n");
  expect(frontMatterProblems(page, "docs/x.md")).toEqual([]);
  expect(fenceProblems("```\nselect 1\n```\n", "docs/x.md")).toEqual([
    "docs/x.md:1 code fence has no language",
  ]);
  expect(fenceProblems("```sql\nselect 1\n```\n", "docs/x.md")).toEqual([]);
  const linked = "See [size](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md).";
  expect(internalLinkProblems(root, "docs/guide.md", linked)).toEqual([
    "docs/guide.md links to internal size.md",
  ]);
});

test("hidden characters fail, and a joiner inside a word needs the allowlist", () => {
  expect(hiddenCharsIn("مرحبا שלום नमस्ते", "docs/x.md", false)).toEqual([]);
  expect(hiddenCharsIn("a\u0000b", "docs/x.md", false)[0]).toContain("NUL");
  expect(hiddenCharsIn("ab\u202Ecd", "docs/x.md", false)[0]).toContain("202E");
  expect(hiddenCharsIn("a\u{E0001}b", "docs/x.md", false)[0]).toContain("E0001");
  expect(hiddenCharsIn("a\u200Bb", "docs/x.md", false)[0]).toContain("200B");
  const word = "می‌روم";
  expect(hiddenCharsIn(word, "docs/x.md", false).length).toBeGreaterThan(0);
  expect(hiddenCharsIn(word, "docs/x.md", true)).toEqual([]);
  expect(hiddenCharsIn("\u200C", "docs/x.md", true).length).toBeGreaterThan(0);
  expect(hiddenCharsIn("ok \uFE0F", "docs/x.md", false)[0]).toContain("variation selector");
});

test("pack growth over 400 KB fails, and a smaller tarball passes", () => {
  expect(packSizeProblems(1_000, 1_000)).toEqual([]);
  expect(packSizeProblems(500, 1_000)).toEqual([]);
  expect(packSizeProblems(PACK_SIZE_LIMIT, 0)).toEqual([]);
  expect(packSizeProblems(PACK_SIZE_LIMIT + 1, 0).length).toBe(1);
});

test("stamp rewrites okmVersion in a copy and restore puts the bytes back", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-pack-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "okmodel", version: "9.9.9-next.3" })}\n`,
    );
    const docs = join(dir, "docs");
    mkdirSync(docs);
    const original = [
      "---",
      'okmVersion: "0.10.0"',
      'since: "0.9"',
      "dialects: [postgres]",
      "codes: []",
      "---",
      "OKModel 0.10.0 - agent index",
      "",
    ].join("\n");
    writeFileSync(join(docs, "index.md"), original);
    expect(stampDocText(original, "9.9.9-next.3")).toContain('okmVersion: "9.9.9-next.3"');
    expect(stampDocText(original, "9.9.9-next.3")).toContain("OKModel 9.9.9-next.3 - agent index");
    stampPackedDocs(dir);
    const stamped = readFileSync(join(docs, "index.md"), "utf8");
    expect(stamped).toContain('okmVersion: "9.9.9-next.3"');
    expect(stamped).not.toContain('okmVersion: "0.10.0"');
    restorePackedDocs(dir);
    expect(readFileSync(join(docs, "index.md"), "utf8")).toBe(original);
  } finally {
    restorePackedDocs(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
