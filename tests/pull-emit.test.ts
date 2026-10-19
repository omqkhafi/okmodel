/**
 * Pull emitter: hostile names, file stems, and foreign-key export bindings (D290).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { column, constraint, table } from "../src/contracts/catalog/object.js";
import type { CatalogObject, Namespace } from "../src/contracts/catalog/types.js";
import { moduleSpecifiers } from "../scripts/specifiers.js";
import { emitPull } from "../src/tooling/migrate/pull-emit.js";

const ns: Namespace = { form: "static", name: "public" };
const provenance = { origin: "file" as const, name: "test" };

test("pull emitter uses export names in references and keeps sqlName", () => {
  const objects: CatalogObject[] = [
    table({ namespace: ns, name: "my-parent", provenance }),
    column({
      parent: { namespace: ns, name: "my-parent" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "my-parent" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "my-child", provenance }),
    column({
      parent: { namespace: ns, name: "my-child" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    column({
      parent: { namespace: ns, name: "my-child" },
      name: "parent_id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "my-child" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "my-child" },
      constraintKind: "foreignKey",
      columns: ["parent_id"],
      nameKey: "parent_id",
      provenance,
      references: {
        parent: { namespace: ns, name: "my-parent" },
        columns: ["id"],
      },
    }),
  ];
  const dir = mkdtempSync(join(tmpdir(), "okm-emit-fk-"));
  try {
    const emitted = emitPull(catalog(objects), {
      schemaFile: join(dir, "schema.ts"),
      tablesDir: join(dir, "tables"),
    });
    const child = emitted.files.find((file) => file.path.endsWith("my_child.ts"));
    expect(child?.text).toContain('.references("my_parent"');
    expect(child?.text).not.toContain('.references("my-parent"');
    const parent = emitted.files.find((file) => file.path.endsWith("my_parent.ts"));
    expect(parent?.text).toContain('sqlName: "my-parent"');
    const relativeImports = emitted.files.flatMap((file) =>
      moduleSpecifiers(file.text, file.path).filter((specifier) => specifier.startsWith(".")),
    );
    expect(relativeImports.length).toBeGreaterThan(0);
    expect(relativeImports).toEqual(["./tables/my_child.ts", "./tables/my_parent.ts"]);
    for (const specifier of relativeImports) {
      expect(specifier.endsWith(".ts")).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull emitter writes a computed key for __proto__ and unique safe file stems", () => {
  const objects: CatalogObject[] = [
    table({ namespace: ns, name: "Tasks", provenance }),
    column({
      parent: { namespace: ns, name: "Tasks" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "Tasks" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "tasks", provenance }),
    column({
      parent: { namespace: ns, name: "tasks" },
      name: "__proto__",
      dataType: "text",
      nullable: false,
      provenance,
    }),
    column({
      parent: { namespace: ns, name: "tasks" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "tasks" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "con", provenance }),
    column({
      parent: { namespace: ns, name: "con" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "con" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "aux", provenance }),
    column({
      parent: { namespace: ns, name: "aux" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "aux" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "nul", provenance }),
    column({
      parent: { namespace: ns, name: "nul" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "nul" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
    table({ namespace: ns, name: "com1", provenance }),
    column({
      parent: { namespace: ns, name: "com1" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "com1" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
  ];
  const dir = mkdtempSync(join(tmpdir(), "okm-emit-names-"));
  try {
    const emitted = emitPull(catalog(objects), {
      schemaFile: join(dir, "schema.ts"),
      tablesDir: join(dir, "tables"),
    });
    const stems = emitted.files
      .filter((file) => file.path !== join(dir, "schema.ts"))
      .map((file) => file.path.slice(join(dir, "tables").length + 1));
    expect(stems).toContain("Tasks.ts");
    expect(stems).toContain("tasks_2.ts");
    expect(stems).toContain("_con.ts");
    expect(stems).toContain("_aux.ts");
    expect(stems).toContain("_nul.ts");
    expect(stems).toContain("_com1.ts");
    expect(stems.some((name) => /^con\.ts$/i.test(name))).toBe(false);
    const tasks = emitted.files.find((file) => file.path.endsWith("tasks_2.ts"));
    expect(tasks?.text).toContain("export const tasks_2");
    expect(tasks?.text).toContain('sqlName: "tasks"');
    expect(tasks?.text).toContain('["__proto__"]:');
    const again = emitPull(catalog(objects), {
      schemaFile: join(dir, "schema-b.ts"),
      tablesDir: join(dir, "tables-b"),
    });
    expect(
      again.files
        .filter((file) => file.path !== join(dir, "schema-b.ts"))
        .map((file) => file.path.slice(join(dir, "tables-b").length + 1)),
    ).toEqual(stems);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull emitter keeps a space in sqlName and sanitizes the file stem", () => {
  const objects: CatalogObject[] = [
    table({ namespace: ns, name: "my table", provenance }),
    column({
      parent: { namespace: ns, name: "my table" },
      name: "id",
      dataType: "integer",
      nullable: false,
      provenance,
    }),
    constraint({
      parent: { namespace: ns, name: "my table" },
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
  ];
  const dir = mkdtempSync(join(tmpdir(), "okm-emit-space-"));
  try {
    const emitted = emitPull(catalog(objects), {
      schemaFile: join(dir, "schema.ts"),
      tablesDir: join(dir, "tables"),
    });
    const file = emitted.files.find((item) => item.path.endsWith("my_table.ts"));
    expect(file).toBeDefined();
    expect(file?.text).toContain('sqlName: "my table"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
