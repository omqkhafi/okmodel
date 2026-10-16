/**
 * Shared round trip for `okm import drizzle`.
 *
 * Imports the fixture, builds it, applies the SQL, and compares introspection
 * with the Drizzle table configs.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { catalog } from "../src/contracts/catalog/build.js";
import type {
  Catalog,
  ColumnObject,
  ConstraintObject,
  IndexObject,
} from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { importDrizzle } from "../src/tooling/migrate/import-drizzle.js";
import { buildProject, loadSchema } from "../src/tooling/migrate/project.js";
import { canonicalTypeName } from "../src/tooling/migrate/type-name.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

/** Drizzle fixture the command imports. */
export const fixturePath = join(root, "tests/fixtures/drizzle/schema.ts");

/**
 * Imports the fixture, builds the project, applies SQL, and checks the live catalog.
 *
 * @param apply - Creates `shop`, runs the statements, and introspects `shop`
 */
export async function roundTrip(
  apply: (statements: readonly string[]) => Promise<Catalog>,
): Promise<void> {
  const cwd = mkdtempSync(join(root, ".okm-import-"));
  try {
    const imported = await importDrizzle(cwd, [fixturePath, "--out", "adopted"]);
    expect(imported.namespace).toBe("shop");
    expect(imported.text).toContain("namespace shop");
    expect(imported.text).toContain("not imported");
    expect(imported.text).toContain("references() takes one local column");
    expect(imported.text).toContain("relations() is not a foreign key");
    expect(imported.text).toContain("authorsRelations");
    expect(imported.text).toContain("mood");
    expect(imported.text).toContain("extra_seq");
    expect(imported.text).toContain("notes_n_seq");
    expect(imported.text).toContain("extras_id_seq");
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      `import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./adopted/schema.ts",
  tables: "./adopted/tables",
  namespace: "shop",
});
`,
    );
    await buildProject(cwd);
    const built = await loadSchema(cwd, "./adopted/schema.ts");
    const live = await apply(renderCatalog(built.catalog, "shop"));
    await assertLive(live);
    const notes = await Bun.file(join(cwd, "adopted/tables/notes.ts")).text();
    expect(notes).toContain("authorId");
    expect(notes).toContain('sqlName("author_id")');
    const authors = await Bun.file(join(cwd, "adopted/tables/authors.ts")).text();
    expect(authors).toContain("fullName");
    expect(authors).toContain('sqlName("full_name")');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function assertLive(live: Catalog): Promise<void> {
  const imported: unknown = await import(pathToFileURL(fixturePath).href);
  const pg = (await import("drizzle-orm/pg-core")) as unknown as {
    getTableConfig: (table: object) => {
      readonly name: string;
      readonly schema: string | undefined;
      readonly columns: readonly object[];
      readonly indexes: readonly {
        readonly config: {
          readonly columns: readonly object[];
          readonly unique: boolean;
          readonly where?: unknown;
        };
      }[];
      readonly foreignKeys: readonly {
        readonly onDelete: string | undefined;
        readonly reference: () => {
          readonly columns: readonly { readonly name: string }[];
          readonly foreignColumns: readonly { readonly name: string }[];
          readonly foreignTable: object;
        };
      }[];
      readonly primaryKeys: readonly { readonly columns: readonly { readonly name: string }[] }[];
      readonly checks: readonly unknown[];
    };
  };
  const orm = (await import("drizzle-orm")) as unknown as {
    getTableColumns: (table: object) => Record<string, object>;
  };
  if (typeof imported !== "object" || imported === null) {
    throw new Error("fixture");
  }
  const module = imported as Record<string, unknown>;
  for (const value of Object.values(module)) {
    if (typeof value !== "object" || value === null || !("getSQL" in value)) continue;
    let config: ReturnType<typeof pg.getTableConfig>;
    try {
      config = pg.getTableConfig(value);
    } catch {
      continue;
    }
    if (config.schema !== "shop") continue;
    const columns = orm.getTableColumns(value);
    const liveColumns = live.objects.filter(
      (object): object is ColumnObject =>
        object.kind === "column" && object.identity.parent.name === config.name,
    );
    for (const [property, column] of Object.entries(columns)) {
      const sqlName = stringField(column, "name") ?? property;
      const type = sqlType(column);
      if (type === "mood") {
        expect(liveColumns.some((item) => item.identity.name === sqlName)).toBe(false);
        continue;
      }
      const found = liveColumns.find((item) => item.identity.name === sqlName);
      expect(found, `${config.name}.${sqlName}`).toBeDefined();
      if (found === undefined) continue;
      const serial = type === "serial" || type === "bigserial" || type === "smallserial";
      const expectedType =
        type === "serial"
          ? "integer"
          : type === "bigserial"
            ? "bigint"
            : type === "smallserial"
              ? "smallint"
              : (type ?? "");
      expect(canonicalTypeName(found.definition.dataType)).toBe(canonicalTypeName(expectedType));
      const generated = recordField(column, "generated") !== undefined;
      const identity = recordField(column, "generatedIdentity");
      if (!generated) expect(found.definition.nullable).toBe(!flag(column, "notNull"));
      if (serial) expect(found.definition.defaultExpression).toBeUndefined();
      if (identity !== undefined && typeof identity === "object" && identity !== null) {
        expect(found.definition.identity?.always).toBe(stringField(identity, "type") === "always");
      }
      if (generated) {
        expect(found.definition.generated?.stored).toBe(true);
        expect(found.definition.generated?.expression).toContain("1");
      }
      const def = stringField(column, "default") ?? sqlText(recordField(column, "default"));
      if (typeof recordField(column, "default") === "string") {
        expect(found.definition.defaultExpression ?? "").toContain("untitled");
      }
      if (recordField(column, "default") === true) {
        expect(found.definition.defaultExpression).toBe("true");
      }
      if (def?.includes("gen_random_uuid")) {
        expect(found.definition.defaultExpression ?? "").toContain("gen_random_uuid");
      }
    }
    const primary = live.objects.find(
      (object): object is ConstraintObject =>
        object.kind === "constraint" &&
        object.definition.constraintKind === "primaryKey" &&
        object.identity.parent.name === config.name,
    );
    const expectedPrimary =
      config.primaryKeys[0]?.columns.map((item) => item.name) ??
      Object.values(columns)
        .filter((column) => flag(column, "primary"))
        .map((column) => stringField(column, "name") ?? "");
    expect(primary?.definition.columns).toEqual(expectedPrimary);
    const uniques = live.objects.filter(
      (object): object is ConstraintObject =>
        object.kind === "constraint" &&
        object.definition.constraintKind === "unique" &&
        object.identity.parent.name === config.name,
    );
    for (const column of Object.values(columns)) {
      if (!flag(column, "isUnique")) continue;
      const name = stringField(column, "name") ?? "";
      expect(uniques.some((item) => item.definition.columns.join(",") === name)).toBe(true);
    }
    const indexes = live.objects.filter(
      (object): object is IndexObject =>
        object.kind === "index" && object.identity.parent.name === config.name,
    );
    for (const index of config.indexes) {
      const names = index.config.columns
        .map((column) => stringField(column, "name"))
        .filter((name): name is string => name !== undefined);
      const found = indexes.find((item) => item.definition.columns.join(",") === names.join(","));
      expect(found, `${config.name} index ${names.join(",")}`).toBeDefined();
      expect(found?.definition.unique).toBe(index.config.unique);
      if (index.config.where !== undefined)
        expect(found?.definition.predicate?.length ?? 0).toBeGreaterThan(0);
    }
    const foreign = live.objects.filter(
      (object): object is ConstraintObject =>
        object.kind === "constraint" &&
        object.definition.constraintKind === "foreignKey" &&
        object.identity.parent.name === config.name,
    );
    for (const key of config.foreignKeys) {
      const ref = key.reference();
      if (ref.columns.length !== 1) {
        expect(foreign.some((item) => item.definition.columns.length > 1)).toBe(false);
        continue;
      }
      const local = ref.columns[0]?.name ?? "";
      const found = foreign.find((item) => item.definition.columns[0] === local);
      expect(found, `${config.name}.${local}`).toBeDefined();
      expect(found?.definition.references?.parent.name).toBe(
        pg.getTableConfig(ref.foreignTable).name,
      );
      expect(found?.definition.references?.columns).toEqual(
        ref.foreignColumns.map((item) => item.name),
      );
      if (key.onDelete === "cascade")
        expect(found?.definition.references?.onDelete).toBe("cascade");
    }
    if (config.checks.length > 0) {
      const checks = live.objects.filter(
        (object): object is ConstraintObject =>
          object.kind === "constraint" &&
          object.definition.constraintKind === "check" &&
          object.identity.parent.name === config.name,
      );
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.some((item) => (item.definition.expression ?? "").includes("length"))).toBe(
        true,
      );
    }
    const status = liveColumns.find((item) => item.identity.name === "status");
    if (status !== undefined) {
      expect(status.definition.dataType).toBe("note_status");
      const enumType = live.objects.find(
        (object) => object.kind === "type" && object.identity.name === "note_status",
      );
      expect(
        enumType?.kind === "type" && "labels" in enumType.definition
          ? enumType.definition.labels
          : [],
      ).toEqual(["open", "closed"]);
    }
  }
  expect(catalog(live.objects).objects.length).toBeGreaterThan(0);
}

function sqlType(value: object): string | undefined {
  if (!("getSQLType" in value) || typeof value.getSQLType !== "function") return undefined;
  const type = (value.getSQLType as () => unknown).call(value);
  return typeof type === "string" ? type : undefined;
}

function sqlText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const chunks = recordField(value, "queryChunks");
  if (!Array.isArray(chunks)) return undefined;
  let text = "";
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) return undefined;
    const literal = recordField(chunk, "value");
    if (Array.isArray(literal) && typeof literal[0] === "string") text += literal[0];
  }
  return text;
}

function flag(value: object, key: string): boolean {
  return recordField(value, key) === true;
}

function stringField(value: object, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function recordField(value: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}
