/**
 * Writes the TypeScript projects the measurement and the snapshots compile.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { type SchemaFixture } from "@okmodel/harness/fixtures";

import { emitDeclarations } from "./emit.js";
import { planTable } from "./plan.js";

const sourceRoot = import.meta.dir;

/** Compiler options shared by every measured project. */
export const projectConfig = {
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
    types: [],
  },
} as const;

/**
 * Writes `tsconfig.json` for a project that already has sources.
 *
 * @param dir - Project directory
 * @param files - Files to include, relative to `dir`
 */
export function writeProjectConfig(
  dir: string,
  files: readonly string[],
  options?: { readonly skipLibCheck?: boolean },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const config = {
    ...projectConfig,
    compilerOptions: {
      ...projectConfig.compilerOptions,
      noEmit: true,
      skipLibCheck: options?.skipLibCheck ?? true,
    },
    files,
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Writes an empty project, used as the compiler baseline.
 *
 * @param dir - Project directory
 * @param options - Set `skipLibCheck` false to also check the standard library
 */
export function writeEmptyProject(
  dir: string,
  options?: { readonly skipLibCheck?: boolean },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe.ts"), "export type Probe = number;\n");
  writeProjectConfig(dir, ["probe.ts"], options);
}

/**
 * Writes table calls inferred from a fixture, plus a probe that names every row.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param options - Branding, extension columns, and a `Register` lookup
 */
export function writeInferredProject(
  dir: string,
  fixture: SchemaFixture,
  options?: {
    readonly brandIds?: boolean;
    readonly extensions?: boolean;
    readonly register?: boolean;
  },
): void {
  const brandIds = options?.brandIds ?? true;
  const extensions = options?.extensions ?? false;
  const register = options?.register ?? false;
  mkdirSync(dir, { recursive: true });
  const spec = (file: string): string => specifier(dir, join(sourceRoot, file));
  const lines: string[] = [
    `import { t } from "${spec("column.ts")}";`,
    `import { schema } from "${spec("schema.ts")}";`,
    `import { table } from "${spec("table.ts")}";`,
  ];
  if (extensions) {
    lines.push(
      `import { packCitext, packCube, packEarth, packExtensions, packHstore, packIsn, packLquery, packLtree, packPoint, packSeg, packVector } from "${spec("extensions/pack.ts")}";`,
    );
  }
  lines.push("");
  const consts: string[] = [];
  const extensionCalls = [
    "packCitext()",
    "packLtree()",
    "packVector()",
    "packHstore()",
    "packCube()",
    "packIsn()",
    "packSeg()",
    "packLquery()",
    "packEarth()",
    "packPoint()",
  ];
  for (const [index, fixtureTable] of fixture.tables.entries()) {
    consts.push(fixtureTable.name);
    const columns = planTable(fixtureTable, { brandIds });
    const fields = columns.map((column) => `  ${column.name}: ${column.expression},`);
    if (extensions) {
      const call = extensionCalls[index % extensionCalls.length] ?? "packCitext()";
      fields.push(`  ext: ${call},`);
    }
    lines.push(`export const ${fixtureTable.name} = table("${fixtureTable.name}", {`);
    lines.push(fields.join("\n"));
    lines.push("});", "");
  }
  lines.push("export const appSchema = schema({");
  if (extensions) {
    lines.push("  extensions: packExtensions(),");
  }
  lines.push(`  tables: [${consts.join(", ")}],`);
  lines.push("});", "");
  if (register) {
    lines.push('declare module "./registry.js" {');
    lines.push("  interface Register {");
    lines.push("    readonly schema: typeof appSchema;");
    lines.push("  }");
    lines.push("}", "");
  }
  writeFileSync(join(dir, "tables.ts"), `${lines.join("\n")}\n`);
  if (register) {
    writeFileSync(join(dir, "registry.ts"), "export interface Register {}\n");
    writeFileSync(
      join(dir, "probe.ts"),
      [
        'import "./tables.js";',
        'import type { Register } from "./registry.js";',
        `import type { AnySchema, Insert, Row, Update } from "${spec("schema.ts")}";`,
        "",
        "type Registered = Register extends { readonly schema: infer S extends AnySchema }",
        "  ? S",
        "  : never;",
        'type Names = keyof Registered["~byName"] & string;',
        "export type Probe = {",
        "  readonly rows: { readonly [K in Names]: Row<K, Registered> };",
        "  readonly inserts: { readonly [K in Names]: Insert<K, Registered> };",
        "  readonly updates: { readonly [K in Names]: Update<K, Registered> };",
        "};",
        "",
      ].join("\n"),
    );
    writeProjectConfig(dir, ["probe.ts", "tables.ts", "registry.ts"]);
    return;
  }
  const extensionProbe = extensions
    ? 'export type Extensions = typeof appSchema["~extensions"];\n'
    : "";
  writeFileSync(
    join(dir, "probe.ts"),
    [
      'import { appSchema } from "./tables.js";',
      `import type { Insert, Row, TableName, Update } from "${spec("schema.ts")}";`,
      "",
      "type Names = TableName<typeof appSchema>;",
      "export type Probe = {",
      "  readonly rows: { readonly [K in Names]: Row<K, typeof appSchema> };",
      "  readonly inserts: { readonly [K in Names]: Insert<K, typeof appSchema> };",
      "  readonly updates: { readonly [K in Names]: Update<K, typeof appSchema> };",
      "};",
      extensionProbe,
    ].join("\n"),
  );
  writeProjectConfig(dir, ["probe.ts", "tables.ts"]);
}

/**
 * Writes emitted declarations and a probe that reads them.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param options - Branding, kept in step with the inferred project
 */
export function writeEmittedProject(
  dir: string,
  fixture: SchemaFixture,
  options?: { readonly brandIds?: boolean; readonly skipLibCheck?: boolean },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "types.d.ts"), emitDeclarations(fixture, options));
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
  writeProjectConfig(dir, ["probe.ts"], { skipLibCheck: options?.skipLibCheck ?? true });
}

/**
 * Writes a project that instantiates {@link DuplicateNames} on `count` names.
 *
 * @param dir - Project directory
 * @param count - Tuple length
 */
export function writeDuplicateProject(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: count }, (_value, index) => `"n${String(index)}"`);
  const spec = specifier(dir, join(sourceRoot, "schema.ts"));
  writeFileSync(
    join(dir, "probe.ts"),
    [
      `import type { DuplicateNames } from "${spec}";`,
      "",
      `type Names = [${names.join(", ")}];`,
      "export type Dup = DuplicateNames<Names>;",
      "",
    ].join("\n"),
  );
  writeProjectConfig(dir, ["probe.ts"]);
}

/**
 * Module specifier from a generated file to a spike source file.
 *
 * @param fromDir - Directory of the importing file
 * @param file - Absolute path ending in `.ts`
 * @returns A relative `nodenext` specifier ending in `.js`
 */
export function specifier(fromDir: string, file: string): string {
  let spec = relative(fromDir, file).replaceAll("\\", "/");
  if (!spec.startsWith(".")) {
    spec = `./${spec}`;
  }
  return spec.replace(/\.ts$/, ".js");
}
