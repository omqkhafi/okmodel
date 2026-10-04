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
 * Query features the 200-table probe can exercise on top of `find`, `insert`, `update`, and `delete`.
 *
 * The gated probe uses none. Each feature is measured on its own row and printed.
 */
export type ProbeFeature = "page" | "aggregate" | "through";

const PROBE_FEATURES: readonly ProbeFeature[] = [];

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
  options: { readonly validate?: boolean; readonly features?: readonly ProbeFeature[] } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const pg = libraryFile(dir, target, "dialects/pg/index");
  const runtime = libraryFile(dir, target, "runtime/types");
  const validate = options.validate === true;
  const features = options.features ?? PROBE_FEATURES;
  const through = features.includes("through");
  const lines: string[] = [
    ...(validate ? [`import "${libraryFile(dir, target, "runtime/validate/index")}";`] : []),
    `import { many, ${through ? "manyThrough, " : ""}one, schema, table, t } from "${pg}";`,
    "",
  ];
  lines.push(
    'export const owner = table("owner", { id: t.id(), email: t.text() }, { relations: { notes: many("note") } });',
    "",
    'export const note = table("note", {',
    "  id: t.id(),",
    '  ownerId: t.uuid().references("owner"),',
    "  body: t.text(),",
    `}, { relations: { owner: one("owner")${through ? ', tags: manyThrough("tag", { through: "noteTag" })' : ""} } });`,
    "",
  );
  const names = ["owner", "note"];
  if (through) {
    lines.push(
      'export const tag = table("tag", { id: t.id(), label: t.text() });',
      "",
      'export const noteTag = table("noteTag", {',
      "  id: t.id(),",
      '  noteId: t.uuid().references("note"),',
      '  tagId: t.uuid().references("tag"),',
      "});",
      "",
    );
    names.push("tag", "noteTag");
  }
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
  if (validate) lines.push("  validation: true,");
  lines.push("});", "");
  writeFileSync(join(dir, "tables.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(dir, "probe.ts"),
    [
      "import { eq" + (through ? ", has" : "") + ' } from "' + pg + '";',
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
      ...(features.includes("page")
        ? [
            "export function paged(db: Connected<typeof appSchema>) {",
            '  return db.note.page({ select: ["id", "body"] as const, orderBy: { body: "asc" }, limit: 2 });',
            "}",
            "",
          ]
        : []),
      ...(features.includes("aggregate")
        ? [
            "export function grouped(db: Connected<typeof appSchema>) {",
            '  return db.note.aggregate({ groupBy: ["ownerId"] as const, count: true, min: ["body"] as const, limit: 5 });',
            "}",
            "",
          ]
        : []),
      ...(through
        ? [
            "export function tagged(db: Connected<typeof appSchema>) {",
            '  return db.note.find({ where: { tags: has({ label: eq("a") }) }, include: { tags: { limit: 3 } }, limit: 2 });',
            "}",
            "",
          ]
        : []),
      ...(validate
        ? [
            "export function checked(db: Connected<typeof appSchema>) {",
            '  return db.note.insert.validate({ ownerId: "00000000-0000-4000-8000-000000000001", body: "a" });',
            "}",
            "",
          ]
        : []),
    ].join("\n"),
  );
  writeConfig(dir, ["probe.ts", "tables.ts"]);
}

/**
 * Writes a project that imports `okmodel/validate` and calls the typed surface.
 *
 * Measured and printed. Not a ceiling. The 200-table query probe stays on its gate.
 *
 * @param dir - Project directory
 * @param target - Declarations a consumer would read, or the library source
 */
export function writeValidateProject(dir: string, target?: LibraryTarget): void {
  mkdirSync(dir, { recursive: true });
  const pg = libraryFile(dir, target, "dialects/pg/index");
  const contracts = libraryFile(dir, target, "contracts/index");
  const runtime = libraryFile(dir, target, "runtime/types");
  const validate = libraryFile(dir, target, "runtime/validate/index");
  const surface = libraryFile(dir, target, "runtime/validate/surface");
  writeFileSync(
    join(dir, "probe.ts"),
    [
      `import "${validate}";`,
      `import type { Input } from "${contracts}";`,
      `import { schema, table, t } from "${pg}";`,
      `import type { Connected } from "${runtime}";`,
      `import type { InputBody } from "${surface}";`,
      "",
      'const tasks = table("tasks", {',
      "  id: t.uuid(),",
      "  title: t.varchar(20),",
      "  secret: t.text().guarded(),",
      "}, { validation: true });",
      "",
      "export const app = schema({ tables: [tasks], validation: true });",
      "",
      'export type Body = InputBody<typeof app, "tasks">;',
      'export type Mark = Input<"tasks", typeof app>;',
      "",
      "export function check(db: Connected<typeof app>, body: Body) {",
      "  return db.tasks.insert.validate(body);",
      "}",
      "",
      "export function patch(db: Connected<typeof app>) {",
      '  return db.tasks.update.validate({ title: "a" });',
      "}",
      "",
    ].join("\n"),
  );
  writeConfig(dir, ["probe.ts"]);
}

/**
 * Writes an emitted project from {@link emitRowTypes}.
 *
 * That function is the row-type text `okm build` writes. The probe reads the
 * declaration file and does not import the builders.
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
