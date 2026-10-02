/**
 * Type-cost projects for the production `table()` and `schema()` API.
 *
 * Inferred projects typecheck source that calls the builders. Emitted
 * projects typecheck only the declaration file `emitRowTypes` writes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { type SchemaFixture } from "../packages/harness/src/fixtures.js";
import { emitRowTypes } from "../src/dialects/pg/emit.js";
import { columnCall, fixtureSchema } from "./fixture-schema.js";
import { repoRoot } from "./root.js";

/** Where a measured project reads the library. */
export type LibraryTarget = {
  /** Built declaration root (`dist`-shaped). Absent means the TypeScript source. */
  readonly declarations?: string;
};

/**
 * Writes an inferred project: production `table()` and `schema()`, plus a probe.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param target - Declarations a consumer would read, or the library source
 */
export function writeProductionInferredProject(
  dir: string,
  fixture: SchemaFixture,
  target?: LibraryTarget,
): void {
  mkdirSync(dir, { recursive: true });
  const pg = libraryFile(dir, target, "dialects/pg/index");
  const contracts = libraryFile(dir, target, "contracts/index");
  const lines: string[] = [`import { schema, table, t } from "${pg}";`, ""];
  const names: string[] = [];
  for (const item of fixture.tables) {
    names.push(item.name);
    lines.push(`export const ${item.name} = table("${item.name}", {`);
    for (const column of item.columns) {
      lines.push(`  ${column.name}: ${columnCall(item, column)},`);
    }
    lines.push("});", "");
  }
  lines.push("export const appSchema = schema({");
  lines.push(`  tables: [${names.join(", ")}],`);
  lines.push("});", "");
  writeFileSync(join(dir, "tables.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(dir, "probe.ts"),
    [
      'import { appSchema } from "./tables.js";',
      `import type { Insert, Row, TableName, Update } from "${contracts}";`,
      "",
      "type Names = TableName<typeof appSchema>;",
      "export type Probe = {",
      "  readonly rows: { readonly [K in Names]: Row<K, typeof appSchema> };",
      "  readonly inserts: { readonly [K in Names]: Insert<K, typeof appSchema> };",
      "  readonly updates: { readonly [K in Names]: Update<K, typeof appSchema> };",
      "};",
      "",
    ].join("\n"),
  );
  writeConfig(dir, ["probe.ts", "tables.ts"]);
}

/**
 * Writes a read-path project: filter, select, include, and orderBy.
 *
 * The fixture tables stay. Two related tables carry the query so include has
 * a target. The probe types a connected client from the built declarations.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param target - Declarations a consumer would read, or the library source
 */
export function writeQueryProject(
  dir: string,
  fixture: SchemaFixture,
  target?: LibraryTarget,
): void {
  mkdirSync(dir, { recursive: true });
  const pg = libraryFile(dir, target, "dialects/pg/index");
  const runtime = libraryFile(dir, target, "runtime/types");
  const lines: string[] = [`import { many, one, schema, table, t } from "${pg}";`, ""];
  lines.push(
    'export const owner = table("owner", { id: t.id(), email: t.text() }, { relations: { notes: many("note") } });',
    "",
    'export const note = table("note", {',
    "  id: t.id(),",
    '  ownerId: t.uuid().references("owner"),',
    "  body: t.text(),",
    '}, { relations: { owner: one("owner") } });',
    "",
  );
  const names = ["owner", "note"];
  for (const item of fixture.tables) {
    names.push(item.name);
    lines.push(`export const ${item.name} = table("${item.name}", {`);
    for (const column of item.columns) {
      lines.push(`  ${column.name}: ${columnCall(item, column)},`);
    }
    lines.push("});", "");
  }
  lines.push("export const appSchema = schema({");
  lines.push(`  tables: [${names.join(", ")}],`);
  lines.push("});", "");
  writeFileSync(join(dir, "tables.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(dir, "probe.ts"),
    [
      'import { eq } from "' + pg + '";',
      'import type { Connected } from "' + runtime + '";',
      'import { appSchema } from "./tables.js";',
      "",
      "export function read(db: Connected<typeof appSchema>) {",
      "  return db.note.find({",
      '    where: { body: eq("a") },',
      '    select: ["id", "body"] as const,',
      '    orderBy: { body: "asc" },',
      "    limit: 2,",
      '    include: { owner: { select: ["email"] as const } },',
      "  });",
      "}",
      "",
      "export function write(db: Connected<typeof appSchema>) {",
      '  return db.note.insert({ ownerId: "00000000-0000-4000-8000-000000000001", body: "a" });',
      "}",
      "",
      "export function change(db: Connected<typeof appSchema>) {",
      '  return db.note.update({ where: { body: "a" }, set: { body: "b" } });',
      "}",
      "",
      "export function remove(db: Connected<typeof appSchema>) {",
      '  return db.note.delete({ where: { body: "b" } });',
      "}",
      "",
    ].join("\n"),
  );
  writeConfig(dir, ["probe.ts", "tables.ts"]);
}

/**
 * Writes an emitted project from {@link emitRowTypes}.
 *
 * The probe reads the declaration file and does not import the builders.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 */
export function writeProductionEmittedProject(dir: string, fixture: SchemaFixture): void {
  mkdirSync(dir, { recursive: true });
  const built = fixtureSchema(fixture);
  writeFileSync(join(dir, "types.d.ts"), emitRowTypes(built));
  writeFileSync(
    join(dir, "probe.ts"),
    [
      'import type { Inserts, Rows, Updates } from "./types.js";',
      "",
      "export type Probe = {",
      "  readonly rows: { readonly [K in keyof Rows]: Rows[K] };",
      "  readonly inserts: { readonly [K in keyof Inserts]: Inserts[K] };",
      "  readonly updates: { readonly [K in keyof Updates]: Updates[K] };",
      "};",
      "",
    ].join("\n"),
  );
  writeConfig(dir, ["probe.ts"]);
}

/**
 * Writes the column sample against built declarations.
 *
 * The checked-in fixture imports library source. This copy imports the `.d.ts`.
 *
 * @param dir - Project directory
 * @param declarations - Declaration root
 */
export function writeColumnProject(dir: string, declarations: string): void {
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(
    join(repoRoot(), "tests/fixtures/type-cost-columns/columns.ts"),
    "utf8",
  );
  const pg = specifier(dir, join(declarations, "dialects/pg/index.d.ts"));
  writeFileSync(
    join(dir, "columns.ts"),
    source.replace('from "../../../src/dialects/pg/index.js"', `from "${pg}"`),
  );
  writeConfig(dir, ["columns.ts"]);
}

function writeConfig(dir: string, files: readonly string[]): void {
  const config = {
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noImplicitReturns: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2023",
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    files,
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
}

/**
 * Module specifier for the Postgres or contracts entry.
 *
 * A declaration target points at the built `.d.ts`. Source points at `src/`.
 *
 * @param dir - Project directory
 * @param target - Declarations or source
 * @param entry - Path under `src/` or the declaration root, without an extension
 */
function libraryFile(dir: string, target: LibraryTarget | undefined, entry: string): string {
  const file =
    target?.declarations === undefined
      ? join(repoRoot(), "src", `${entry}.ts`)
      : join(target.declarations, `${entry}.d.ts`);
  return specifier(dir, file);
}

function specifier(fromDir: string, file: string): string {
  let spec = relative(fromDir, file).replaceAll("\\", "/");
  if (!spec.startsWith(".")) {
    spec = `./${spec}`;
  }
  return spec.replace(/\.d\.ts$/, ".js").replace(/\.ts$/, ".js");
}
