/**
 * fast-check grammar for authored schemas and evolutions.
 */

import fc from "fast-check";

import {
  tagsFor,
  type ColumnModel,
  type ColumnTypeKind,
  type Evolution,
  type FkAction,
  type LifecycleCase,
  type SchemaModel,
  type TableModel,
} from "./model.js";

const FK_ACTIONS: readonly FkAction[] = [
  "cascade",
  "restrict",
  "set null",
  "set default",
  "no action",
];

const SAFE_TYPES: readonly ColumnTypeKind[] = [
  "integer",
  "smallint",
  "text",
  "varchar",
  "boolean",
  "uuid",
  "timestamptz",
  "numeric",
  "jsonb",
];

/** Identifier shapes including mixed case, digits, spaces, and quotes. */
const nameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("tasks", "items", "notes", "posts", "authors"),
  fc
    .tuple(fc.constantFrom("Task", "Item", "Note"), fc.integer({ min: 0, max: 9 }))
    .map(([base, n]) => `${base}${String(n)}`),
  fc.constantFrom("to do", "my item", "a b"),
  fc.constantFrom('say "hi"', "o'neil"),
);

const keyArb = fc.integer({ min: 0, max: 9999 }).map((n) => `k${String(n)}`);

/**
 * Builds one lifecycle case (initial schema + evolutions + mode).
 *
 * Schemas stay small so the PR tier (~20 cases) finishes under three minutes.
 */
export const lifecycleCaseArb: fc.Arbitrary<LifecycleCase> = fc
  .record({
    casing: fc.constantFrom("omit", "snake") as fc.Arbitrary<"omit" | "snake">,
    namespace: fc.option(fc.constantFrom("appns", "tenant_a"), { nil: undefined }),
    tenancy: fc.boolean(),
    trgm: fc.boolean(),
    withRows: fc.boolean(),
    featurePack: fc.constantFrom(
      "plain",
      "fk",
      "enum",
      "domain",
      "generated",
      "index",
      "trigger",
      "view",
      "archive",
      "picklist",
    ),
    evolutionKind: fc.constantFrom(
      "none",
      "addColumn",
      "renameTable",
      "addEnumValue",
      "addIndex",
      "dropColumnAddIndex",
      "addFk",
    ),
  })
  .chain((pick) =>
    nameArb.chain((taskName) => {
      const parent = baseTable("authors", "authors", {
        id: {
          key: "id",
          name: "id",
          type: "integer",
          nullable: false,
          primaryKey: true,
          unique: false,
          defaultKind: "none",
        },
        label: textColumn("label", "label"),
      });
      let child = baseTable("tasks", taskName, {
        id: identityColumn("id", "id"),
        title: textColumn("title", "title"),
      });
      child = applyPack(child, pick.featurePack, parent);
      const needsParent = pick.featurePack === "fk" || pick.evolutionKind === "addFk";
      const tables: TableModel[] = needsParent ? [parent, child] : [child];
      const namespace = pick.featurePack === "view" ? (pick.namespace ?? "appns") : pick.namespace;
      const initial: SchemaModel = {
        casing: pick.casing,
        ...(namespace === undefined ? {} : { namespace }),
        tenancy: pick.tenancy && pick.featurePack !== "fk" && !needsParent,
        trgm: pick.trgm && pick.featurePack === "index",
        tables,
        triggers:
          pick.featurePack === "trigger"
            ? [
                {
                  name: "tasks_when",
                  tableKey: child.key,
                  when: "OLD.title IS DISTINCT FROM NEW.title",
                },
              ]
            : [],
        views:
          pick.featurePack === "view"
            ? [{ name: "task_ids", tableKey: child.key, columns: ["id"] }]
            : [],
      };
      const evolutions = buildEvolutions(initial, pick.evolutionKind);
      const withRows = pick.withRows && pick.featurePack !== "generated";
      const tags = tagsFor(initial, evolutions, withRows);
      return fc.constant({
        initial,
        evolutions,
        withRows,
        tags,
      });
    }),
  );

function baseTable(key: string, name: string, columns: Record<string, ColumnModel>): TableModel {
  return {
    key,
    name,
    columns: Object.values(columns),
    indexes: [],
    checks: [],
    archive: false,
    versioned: false,
  };
}

function identityColumn(key: string, name: string): ColumnModel {
  return {
    key,
    name,
    type: "identity",
    nullable: false,
    primaryKey: true,
    unique: false,
    defaultKind: "none",
  };
}

function textColumn(key: string, name: string): ColumnModel {
  return {
    key,
    name,
    type: "text",
    nullable: false,
    primaryKey: false,
    unique: false,
    defaultKind: "none",
  };
}

function applyPack(table: TableModel, pack: string, parent: TableModel): TableModel {
  const columns = [...table.columns];
  const indexes = [...table.indexes];
  const checks = [...table.checks];
  let archive = table.archive;
  let versioned = table.versioned;
  switch (pack) {
    case "plain": {
      columns.push({
        key: "n",
        name: "n",
        type: "integer",
        nullable: true,
        primaryKey: false,
        unique: false,
        defaultKind: "constant",
        defaultValue: "0",
      });
      break;
    }
    case "fk": {
      columns.push({
        key: "authorId",
        name: "authorId",
        type: "integer",
        nullable: true,
        primaryKey: false,
        unique: false,
        defaultKind: "none",
        references: {
          table: parent.name,
          onDelete: "no action",
          onUpdate: "cascade",
        },
      });
      break;
    }
    case "enum": {
      columns.push({
        key: "status",
        name: "status",
        type: "enum",
        nullable: false,
        primaryKey: false,
        unique: false,
        defaultKind: "constant",
        defaultValue: "red",
        enumName: "color",
        enumLabels: ["red", "blue"],
      });
      break;
    }
    case "domain": {
      columns.push({
        key: "weight",
        name: "weight",
        type: "domain",
        nullable: false,
        primaryKey: false,
        unique: false,
        defaultKind: "none",
        domainName: "pos",
        domainCheck: "VALUE > 0",
      });
      break;
    }
    case "generated": {
      columns.push(
        {
          key: "a",
          name: "a",
          type: "integer",
          nullable: false,
          primaryKey: false,
          unique: false,
          defaultKind: "constant",
          defaultValue: "1",
        },
        {
          key: "b",
          name: "b",
          type: "integer",
          nullable: false,
          primaryKey: false,
          unique: false,
          defaultKind: "none",
          generated: '"a" + 1',
        },
      );
      break;
    }
    case "index": {
      columns.push({
        key: "code",
        name: "code",
        type: "text",
        nullable: false,
        primaryKey: false,
        unique: false,
        defaultKind: "none",
      });
      indexes.push({ columns: ["code"], unique: true, usingTrgm: false });
      indexes.push({
        columns: ["title"],
        unique: false,
        partial: '"title" IS NOT NULL',
        usingTrgm: false,
      });
      break;
    }
    case "trigger":
    case "view":
      break;
    case "archive": {
      archive = true;
      versioned = true;
      break;
    }
    case "picklist": {
      columns.push({
        key: "status",
        name: "status",
        type: "text",
        nullable: false,
        primaryKey: false,
        unique: false,
        defaultKind: "constant",
        defaultValue: "draft",
        picklist: ["draft", "active", "done"],
      });
      checks.push({ name: "title_len", expression: "char_length(title) > 0" });
      break;
    }
    default:
      break;
  }
  // Sprinkle a second typed column from the safe set for column-type coverage.
  if (pack === "plain") {
    const type = SAFE_TYPES[columns.length % SAFE_TYPES.length] ?? "text";
    if (type === "boolean") {
      columns.push({
        key: "extra",
        name: "extra",
        type,
        nullable: true,
        primaryKey: false,
        unique: false,
        defaultKind: "constant",
        defaultValue: "false",
      });
    } else {
      columns.push({
        key: "extra",
        name: "extra",
        type,
        nullable: true,
        primaryKey: false,
        unique: false,
        defaultKind: "none",
      });
    }
  }
  return { ...table, columns, indexes, checks, archive, versioned };
}

function buildEvolutions(initial: SchemaModel, kind: string): readonly Evolution[] {
  const table = initial.tables[initial.tables.length - 1];
  if (table === undefined || kind === "none") return [];
  switch (kind) {
    case "addColumn":
      return [
        {
          kind: "addColumn",
          tableKey: table.key,
          column: {
            key: "note",
            name: "note",
            type: "text",
            nullable: true,
            primaryKey: false,
            unique: false,
            defaultKind: "none",
          },
        },
      ];
    case "renameTable":
      return [{ kind: "renameTable", tableKey: table.key, nextName: `${table.name}_v2` }];
    case "addEnumValue": {
      const enumCol = table.columns.find((column) => column.type === "enum");
      if (enumCol === undefined) return [];
      return [
        {
          kind: "addEnumValue",
          tableKey: table.key,
          columnKey: enumCol.key,
          value: "green",
        },
      ];
    }
    case "addIndex":
      return [
        {
          kind: "addIndex",
          tableKey: table.key,
          index: { columns: ["title"], unique: false, usingTrgm: false },
        },
      ];
    case "dropColumnAddIndex": {
      const droppable = table.columns.find(
        (column) => !column.primaryKey && column.key !== "title" && column.generated === undefined,
      );
      if (droppable === undefined) return [];
      return [
        { kind: "dropColumn", tableKey: table.key, columnKey: droppable.key },
        {
          kind: "addIndex",
          tableKey: table.key,
          index: { columns: ["title"], unique: false, usingTrgm: false },
        },
      ];
    }
    case "addFk": {
      const parent = initial.tables[0];
      if (parent === undefined || parent.key === table.key) return [];
      return [
        {
          kind: "addFk",
          tableKey: table.key,
          columnKey: "authorId",
          target: parent.name,
          onDelete: "no action",
          onUpdate: "no action",
        },
      ];
    }
    default:
      return [];
  }
}

/** Exported for coverage / tests that want a fixed action list. */
export const lifecycleFkActions = FK_ACTIONS;

/** Exported name arbitrary for unit checks. */
export const lifecycleNameArb = nameArb;

/** Exported key arbitrary (unused by the main arb; kept for shrink helpers). */
export const lifecycleKeyArb = keyArb;
