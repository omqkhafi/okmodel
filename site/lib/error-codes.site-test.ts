/**
 * The Errors page code index matches the registry, and every code has an anchor.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ERROR_DOCS } from "../../src/tooling/errors/registry.js";
import {
  errorCodeAnchor,
  errorCodeIndexMatches,
  errorCodeRows,
  ERROR_CODE_INDEX_BEGIN,
  ERROR_CODE_INDEX_END,
} from "./error-codes";
import { siteRoot } from "./repo";

const pagePath = join(siteRoot(), "content/docs/reference/errors.mdx");

test("the Errors page index matches ERROR_DOCS", () => {
  const rows = errorCodeRows();
  expect(rows.map((row) => row.code)).toEqual(ERROR_DOCS.map((doc) => doc.code));
  expect(errorCodeIndexMatches(readFileSync(pagePath, "utf8"))).toBe(true);
});

test("every registry code has an anchor on the Errors page", () => {
  const page = readFileSync(pagePath, "utf8");
  const start = page.indexOf(ERROR_CODE_INDEX_BEGIN);
  const end = page.indexOf(ERROR_CODE_INDEX_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = page.slice(start, end);
  for (const doc of ERROR_DOCS) {
    const anchor = errorCodeAnchor(doc.code);
    expect(block.includes(`id="${anchor}"`), doc.code).toBe(true);
  }
});
