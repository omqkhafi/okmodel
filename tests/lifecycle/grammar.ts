/**
 * fast-check grammar for authored schemas and evolutions.
 */

import fc from "fast-check";

import {
  sqlName,
  type LifecycleCasing,
  type NameStress,
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
    casing: fc.constantFrom("omit", "snake", "camel"),
    nameStress: fc.constantFrom(
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "collide",
      "long",
    ),
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
      const casing: LifecycleCasing =
        pick.nameStress === "collide" && pick.casing === "omit" ? "snake" : pick.casing;
      const needsParent = pick.featurePack === "fk" || pick.evolutionKind === "addFk";
      const renaming = pick.evolutionKind === "renameTable";
      const reserved = [
        ...(needsParent ? ["authors"] : []),
        ...(pick.featurePack === "view" ? ["task_ids"] : []),
      ];
      const taskTableName = distinctTableName(taskName, reserved, casing);
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
      let child = baseTable("tasks", taskTableName, {
        id: identityColumn("id", "id"),
        title: textColumn("title", "title"),
      });
      child = applyPack(child, pick.featurePack, parent);
      child = applyStress(child, casing, pick.nameStress);
      const tables: TableModel[] = needsParent ? [parent, child] : [child];
      // A rename under defineConfig({ namespace }) is not a schema the planner
      // accepts: the snapshot lives in that schema and the rename looks in public.
      const namespace = renaming
        ? undefined
        : pick.featurePack === "view"
          ? (pick.namespace ?? "appns")
          : pick.namespace;
      const initial: SchemaModel = {
        casing,
        ...(pick.nameStress === "none" ? {} : { stress: pick.nameStress }),
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
      const withRows = pick.withRows;
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

/**
 * Adds a name `schema()` refuses.
 *
 * `collide` is two fields that fold to one SQL name. `long` is one field
 * over the 63-byte identifier limit. `none` leaves the table alone.
 */
function applyStress(table: TableModel, casing: LifecycleCasing, stress: NameStress): TableModel {
  if (stress === "none") return table;
  if (stress === "long") {
    const key = `n${"x".repeat(63)}`;
    return { ...table, columns: [...table.columns, textColumn(key, key)] };
  }
  const pair =
    casing === "camel" ? (["user_id", "userId"] as const) : (["userID", "user_id"] as const);
  return {
    ...table,
    columns: [...table.columns, textColumn(pair[0], pair[0]), textColumn(pair[1], pair[1])],
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
          generated: '("a" + 1)',
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
        partial: "(title IS NOT NULL)",
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
    case "addIndex": {
      const column = freeIndexColumn(table);
      if (column === undefined) return [];
      return [
        {
          kind: "addIndex",
          tableKey: table.key,
          index: { columns: [column], unique: false, usingTrgm: false },
        },
      ];
    }
    case "dropColumnAddIndex": {
      const droppable = table.columns.find(
        (column) => !column.primaryKey && column.key !== "title" && column.generated === undefined,
      );
      if (droppable === undefined) return [];
      const remaining: TableModel = {
        ...table,
        columns: table.columns.filter((column) => column.key !== droppable.key),
        indexes: table.indexes.filter((index) => !index.columns.includes(droppable.key)),
      };
      const column = freeIndexColumn(remaining);
      const steps: Evolution[] = [
        { kind: "dropColumn", tableKey: table.key, columnKey: droppable.key },
      ];
      if (column !== undefined) {
        steps.push({
          kind: "addIndex",
          tableKey: table.key,
          index: { columns: [column], unique: false, usingTrgm: false },
        });
      }
      return steps;
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

/**
 * A column that does not already name an index.
 *
 * The default index identity is `table_column_idx`. A second index on the
 * same column, including a partial one beside a plain one, is OKM1023.
 *
 * @param table - Table the evolution would change
 * @returns Column key, or undefined when every column is already indexed
 */
function freeIndexColumn(table: TableModel): string | undefined {
  const taken = new Set(table.indexes.map((index) => index.columns.join("\0")));
  const candidates = table.columns.filter((column) => column.generated === undefined);
  const title = candidates.find((column) => column.key === "title" && !taken.has(column.key));
  if (title !== undefined) return title.key;
  return candidates.find((column) => !taken.has(column.key))?.key;
}

/**
 * Picks a table name whose SQL spelling is not already used.
 *
 * Two `table()` calls with the same name, or two names that `snake` or `camel`
 * folds together, are rejected by `schema()`.
 *
 * @param name - Candidate authored name
 * @param reserved - Names already used by other tables or views
 * @param casing - Schema casing
 * @returns `name`, or `name` plus a suffix that does not collide
 */
export function distinctTableName(
  name: string,
  reserved: readonly string[],
  casing: LifecycleCasing,
): string {
  const used = new Set(reserved.map((item) => sqlName(casing, item)));
  if (!used.has(sqlName(casing, name))) return name;
  const suffixed = `${name}_b`;
  if (!used.has(sqlName(casing, suffixed))) return suffixed;
  return `${name}_c`;
}

/** Exported for coverage / tests that want a fixed action list. */
export const lifecycleFkActions = FK_ACTIONS;

/** Exported name arbitrary for unit checks. */
export const lifecycleNameArb = nameArb;

/** Exported key arbitrary (unused by the main arb; kept for shrink helpers). */
export const lifecycleKeyArb = keyArb;
