/**
 * A single-file bundle that reads `schema().catalog`.
 *
 * esbuild keeps okmodel in the bundle. `createRequire` then looks for
 * `catalog-compile.js` beside the output file. `armCatalog()` installs the
 * compiler first. Without that call the error names the import.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("esbuild ESM and CJS bundles read schema().catalog after armCatalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-bundle-"));
  try {
    const source = join(dir, "app.ts");
    writeFileSync(
      source,
      [
        `import { armCatalog } from ${JSON.stringify(join(root, "src/dialects/pg/catalog-arm.ts"))};`,
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "armCatalog();",
        'const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });',
        "const built = schema({ tables: [notes] });",
        'const names = built.catalog.objects.filter((object) => object.kind === "table").map((object) => object.identity.name);',
        "process.stdout.write(JSON.stringify(names));",
        "",
      ].join("\n"),
    );
    for (const format of ["esm", "cjs"] as const) {
      const out = join(dir, format === "esm" ? "app.mjs" : "app.cjs");
      const built = bundle(source, out, format);
      expect(built.status, built.stderr).toBe(0);
      const ran = spawnSync(process.execPath, [out], { encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout).toBe('["notes"]');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a single-file bundle without armCatalog names the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-bundle-miss-"));
  try {
    const source = join(dir, "app.ts");
    writeFileSync(
      source,
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'const notes = table("notes", { id: t.integer().primaryKey() });',
        "const built = schema({ tables: [notes] });",
        "process.stdout.write(built.catalog.objects.length.toString());",
        "",
      ].join("\n"),
    );
    const out = join(dir, "app.mjs");
    const built = bundle(source, out, "esm");
    expect(built.status, built.stderr).toBe(0);
    const ran = spawnSync(process.execPath, [out], { encoding: "utf8" });
    expect(ran.status).not.toBe(0);
    const text = `${ran.stdout}\n${ran.stderr}`;
    expect(text).toContain("armCatalog");
    expect(text).toContain("okmodel/pg/catalog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

/**
 * Bundles one app with esbuild. okmodel stays inside the file.
 *
 * @param source - TypeScript entry
 * @param out - Output path
 * @param format - ESM or CJS
 * @returns The esbuild result
 */
function bundle(
  source: string,
  out: string,
  format: "esm" | "cjs",
): { readonly status: number | null; readonly stderr: string } {
  const ran = spawnSync(
    "bunx",
    ["esbuild", source, "--bundle", `--format=${format}`, "--platform=node", `--outfile=${out}`],
    { encoding: "utf8" },
  );
  return { status: ran.status, stderr: `${ran.stdout}\n${ran.stderr}` };
}
