/**
 * The bundled handbook list the proxy reads matches the pages on disk and the
 * pages Fumadocs routes. Regenerate with
 * `bun ./site/scripts/handbook-paths.ts --write`.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { HANDBOOK_PATHS_FILE, renderHandbookPaths } from "../scripts/handbook-paths";
import { docsPageExists } from "./handbook-pages";
import paths from "./handbook-paths.json";
import { source } from "./source";

test("lib/handbook-paths.json is current", () => {
  expect(readFileSync(HANDBOOK_PATHS_FILE, "utf8")).toBe(renderHandbookPaths());
});

test("lib/handbook-paths.json lists exactly the routed handbook pages", () => {
  const routed = source
    .getPages()
    .map((page) => page.url)
    .sort();
  expect([...paths]).toEqual(routed);
});

test("docsPageExists answers from the bundled list", () => {
  expect(docsPageExists("/docs")).toBe(true);
  expect(docsPageExists("/docs/")).toBe(true);
  expect(docsPageExists("/docs/schema/validation")).toBe(true);
  expect(docsPageExists("/docs/reference/cli")).toBe(true);
  expect(docsPageExists("/docs/nope")).toBe(false);
  expect(docsPageExists("/docs/define/table/validation")).toBe(false);
});
