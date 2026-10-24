/**
 * Fills the Errors handbook registry table from `ERROR_DOCS`.
 *
 *   bun ./site/scripts/error-code-index.ts
 *   bun ./site/scripts/error-code-index.ts --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  errorCodeIndexMatches,
  errorCodeRows,
  renderErrorCodeIndexMarkdown,
  withErrorCodeIndex,
} from "../lib/error-codes";
import { siteRoot } from "../lib/repo";

const pagePath = join(siteRoot(), "content/docs/reference/errors.mdx");

const check = process.argv.includes("--check");
const current = readFileSync(pagePath, "utf8");
const count = String(errorCodeRows().length);

if (check) {
  if (!errorCodeIndexMatches(current)) {
    console.error(`${pagePath} is behind the error registry. Run bun ./site/scripts/error-code-index.ts`);
    process.exit(1);
  }
  console.log(`error-code-index: ${count} codes current`);
} else {
  const next = withErrorCodeIndex(current, renderErrorCodeIndexMarkdown());
  if (next === current) {
    console.log(`error-code-index: ${count} codes unchanged`);
  } else {
    writeFileSync(pagePath, next);
    console.log(`error-code-index: wrote ${count} codes`);
  }
}
