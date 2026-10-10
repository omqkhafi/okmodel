/**
 * Public handbook fences type-check against the built package.
 * Opt-outs are printed so a skipped fence stays visible in the test log.
 */

import { expect, test } from "bun:test";

import { mappedPages } from "../lib/docs-map";
import { checkDocsCode, docsCodePages } from "./docs-code";

test("public docs fences typecheck against the built package", () => {
  const report = checkDocsCode();
  const pages = docsCodePages(mappedPages);
  expect(pages.length).toBe(mappedPages.length);

  process.stdout.write(
    `docs code gate: checked ${String(report.checked)}, opted out ${String(report.optedOut.length)}, skipped ${String(report.skippedExamples)} example fences\n`,
  );
  for (const item of report.optedOut) {
    process.stdout.write(`opt-out ${item.page}: ${item.reason}\n  ${item.preview}\n`);
  }
  for (const failure of report.failures) {
    process.stdout.write(`fail ${failure.page}: ${failure.message}\n  ${failure.preview}\n`);
  }

  expect(report.checked).toBeGreaterThan(0);
  expect(report.failures).toEqual([]);
});
