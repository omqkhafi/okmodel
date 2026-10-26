/**
 * `okm pull --casing` is opt-in. The default keeps database names.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { column, constraint, table } from "../src/contracts/catalog/object.js";
import type { CatalogObject, Namespace } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { repoRoot } from "../scripts/root.js";
import { emitPull, formatPullReport } from "../src/tooling/migrate/pull-emit.js";
import { parsePullArgs } from "../src/tooling/migrate/pull.js";

const ns: Namespace = { form: "static", name: "public" };
const provenance = { origin: "file" as const, name: "public" };
const root = repoRoot();

function notes(): CatalogObject[] {
  const parent = { namespace: ns, name: "published_notes" };
  return [
    table({ namespace: ns, name: "published_notes", provenance }),
    column({ parent, name: "id", dataType: "integer", nullable: false, provenance }),
    column({ parent, name: "published_at", dataType: "text", nullable: true, provenance }),
    column({ parent, name: "a_b_c", dataType: "text", nullable: true, provenance }),
    column({ parent, name: "HTML", dataType: "text", nullable: true, provenance }),
    constraint({
      parent,
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
  ];
}

test("pull --casing snake writes keys that round-trip and sqlName for the ones that do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-pull-case-"));
  try {
    const emitted = emitPull(
      catalog(notes()),
      { schemaFile: join(dir, "schema.ts"), tablesDir: join(dir, "tables") },
      undefined,
      { casing: "snake" },
    );
    const tableFile = emitted.files.find((file) => file.path.endsWith("publishedNotes.ts"));
    const schemaFile = emitted.files.find((file) => file.path.endsWith("schema.ts"));
    expect(tableFile?.text).toContain("publishedAt: t.text().nullable(),");
    expect(tableFile?.text).toContain('aBC: t.text().sqlName("a_b_c").nullable(),');
    expect(tableFile?.text).toContain('html: t.text().sqlName("HTML").nullable(),');
    expect(tableFile?.text).not.toContain("sqlName: ");
    expect(schemaFile?.text).toContain('casing: "snake"');
    const report = formatPullReport(
      emitted.counts,
      emitted.skipped,
      [],
      [],
      "pulled",
      [],
      emitted.renames,
    );
    expect(report).toContain("sqlName: 2 — cased key does not round-trip to the database name");
    expect(report).toContain("published_notes.HTML");
    expect(report).toContain("published_notes.a_b_c");
    expect(report).not.toContain("published_notes.published_at");
    expect(parsePullArgs(["--casing", "snake"]).casing).toBe("snake");
    expect(parsePullArgs([]).casing).toBeUndefined();
    writeEmitted(emitted.files);
    rewriteImports(dir);
    const { loadSchema } = await import("../src/tooling/migrate/project.js");
    const built = await loadSchema(dir, "./schema.ts");
    const names = built.catalog.objects
      .filter((object) => object.kind === "column")
      .map((object) => object.identity.name)
      .sort();
    expect(names).toEqual(["HTML", "a_b_c", "id", "published_at"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull without --casing keeps the database name", () => {
  const emitted = emitPull(catalog(notes()), {
    schemaFile: "/tmp/okm-pull-verbatim/schema.ts",
    tablesDir: "/tmp/okm-pull-verbatim/tables",
  });
  const tableFile = emitted.files.find((file) => file.path.endsWith("published_notes.ts"));
  const schemaFile = emitted.files.find((file) => file.path.endsWith("schema.ts"));
  expect(tableFile?.text).toContain("published_at: t.text().nullable(),");
  expect(tableFile?.text).toContain("a_b_c: t.text().nullable(),");
  expect(tableFile?.text).toContain("HTML: t.text().nullable(),");
  expect(tableFile?.text).not.toContain(".sqlName(");
  expect(schemaFile?.text).not.toContain("casing:");
  expect(emitted.renames).toEqual([]);
  let refused: unknown;
  try {
    parsePullArgs(["--casing", "kebab"]);
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(OkmError);
  if (refused instanceof OkmError)
    expect(refused.message).toContain("--casing accepts snake or camel.");
});

function writeEmitted(files: readonly { readonly path: string; readonly text: string }[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.text);
  }
}

function rewriteImports(directory: string): void {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      rewriteImports(path);
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
