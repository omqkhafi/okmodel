/**
 * The Workers entry of `okmodel/pg` installs the catalog compilers.
 *
 * Wrangler resolves the `workerd` condition. `schema()` in that file calls
 * `installCatalogCompiler` before it builds, so a bundle with no
 * `import.meta.url` still compiles `.catalog`. The value exports match the
 * Node entry.
 */

import { expect, test } from "bun:test";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import * as nodePg from "../src/dialects/pg/index.js";
import * as workerPg from "../src/dialects/pg/index.workerd.js";

test("the workers pg entry exports the same values as the node entry", () => {
  expect(Object.keys(workerPg).sort()).toEqual(Object.keys(nodePg).sort());
});

test("workers schema() compiles a unique key from the installed compiler", () => {
  const links = {
    id: nodePg.t.integer().primaryKey(),
    slug: nodePg.t.text().unique(),
  };
  const worker = workerPg.schema({ tables: [workerPg.table("links", links)] });
  const node = nodePg.schema({
    tables: [
      nodePg.table("links", {
        id: nodePg.t.integer().primaryKey(),
        slug: nodePg.t.text().unique(),
      }),
    ],
  });
  expect(serializeCatalog(worker.catalog)).toBe(serializeCatalog(node.catalog));
  expect(serializeCatalog(worker.catalog)).toContain("slug");
});
