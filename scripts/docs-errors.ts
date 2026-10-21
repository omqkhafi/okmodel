/**
 * Writes `docs/errors/<code>.md` for every registry code.
 *
 *   bun run docs:errors
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";
import { pageExample } from "../src/tooling/errors/examples.js";
import { renderErrorPage } from "../src/tooling/errors/page.js";

const directory = join(repoRoot(), "docs/errors");
mkdirSync(directory, { recursive: true });
for (const doc of ERROR_DOCS) {
  writeFileSync(join(directory, `${doc.code}.md`), renderErrorPage(doc, pageExample(doc.code)));
}
