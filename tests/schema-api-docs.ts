/**
 * Loads the handbook `describe.ts` fence the way a script would import it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Catalog } from "../src/contracts/catalog/types.js";
import type { SchemaDescription } from "../src/tooling/migrate/schema-api.js";
import { repoRoot } from "../scripts/root.js";

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg", join(repoRoot(), "src/dialects/pg/index.ts")],
  ["okmodel/migrate", join(repoRoot(), "src/tooling/migrate/index.ts")],
];

/** What the handbook fence exports. */
export type SchemaApiExample = {
  readonly app: { readonly catalog: Catalog };
  readonly description: SchemaDescription;
  readonly catalog: Catalog;
};

/**
 * Imports the reference-page example against `src/`.
 *
 * @returns The schema, the description, and the catalog read back from JSON
 */
export async function loadSchemaApiExample(): Promise<SchemaApiExample> {
  const page = readFileSync(join(repoRoot(), "site/content/docs/reference/schema-api.mdx"), "utf8");
  const body = fence(page, "describe.ts");
  if (body === undefined) throw new Error("schema-api.mdx is missing describe.ts");
  const dir = mkdtempSync(join(tmpdir(), "okm-schema-api-"));
  const file = join(dir, "describe.ts");
  try {
    writeFileSync(file, rewriteImports(body));
    const loaded = (await import(
      `${pathToFileURL(file).href}?schema-api`
    )) as Partial<SchemaApiExample>;
    if (
      loaded.app === undefined ||
      loaded.description === undefined ||
      loaded.catalog === undefined
    ) {
      throw new Error("describe.ts must export app, description, and catalog");
    }
    return loaded as SchemaApiExample;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param text - Handbook page
 * @param title - Fence title
 * @returns The fence body
 */
function fence(text: string, title: string): string | undefined {
  const pattern = new RegExp(`\`\`\`ts title="${title}"\\n([\\s\\S]*?)\`\`\``);
  return pattern.exec(text)?.[1];
}

/**
 * Points package imports at source files.
 *
 * @param body - Fence source
 * @returns Source that imports `src/`
 */
function rewriteImports(body: string): string {
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  return next;
}
