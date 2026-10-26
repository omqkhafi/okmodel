/**
 * `okm import drizzle` on the Drizzle docs shapes matches the okmodel fixture.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { Catalog, CatalogObject } from "../src/contracts/catalog/types.js";
import { importDrizzle } from "../src/tooling/migrate/import-drizzle.js";
import { loadSchema } from "../src/tooling/migrate/project.js";
import { repoRoot } from "../scripts/root.js";
import { docs } from "./fixtures/drizzle-docs/schema.js";

const root = repoRoot();
const drizzleDocs = join(root, "tests/fixtures/drizzle/docs.ts");

test("import drizzle matches the docs table shapes", async () => {
  const cwd = mkdtempSync(join(root, ".okm-import-"));
  try {
    const imported = await importDrizzle(cwd, [drizzleDocs, "--out", "adopted"]);
    expect(imported.namespace).toBe("public");
    expect(imported.text).toContain("imported 3 tables");
    rewriteAdoptedImports(join(cwd, "adopted"));
    const built = await loadSchema(cwd, "./adopted/schema.ts");
    expect(bare(built.catalog)).toEqual(bare(docs.catalog));
    const index = built.catalog.objects.find(
      (object) => object.kind === "index" && object.identity.parent.name === "posts",
    );
    expect(index?.identity.name).toBe("posts_content_idx");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function bare(catalog: Catalog): readonly Omit<CatalogObject, "provenance">[] {
  return catalog.objects.map(({ provenance: _provenance, ...object }) => object);
}

function rewriteAdoptedImports(directory: string): void {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      rewriteAdoptedImports(path);
      continue;
    }
    if (!name.name.endsWith(".ts")) continue;
    let spec = relative(dirname(path), join(root, "src/dialects/pg/index.ts")).replaceAll(
      "\\",
      "/",
    );
    if (!spec.startsWith(".")) spec = `./${spec}`;
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll('from "okmodel/pg"', `from ${JSON.stringify(spec)}`),
    );
  }
}
