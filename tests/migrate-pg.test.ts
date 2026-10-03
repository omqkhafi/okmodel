/**
 * Planning against Postgres: introspection, scratch-database expressions,
 * and applying a plan until the catalog matches.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { enumType } from "../src/contracts/catalog/enum.js";
import { column, constraint, index, table } from "../src/contracts/catalog/object.js";
import type { CatalogObject, Provenance } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  introspectSchema,
  reprintCheck,
  type CatalogQuery,
} from "../src/dialects/pg/introspect.js";
import { schema, sql as sqlText, table as defineTable, t } from "../src/dialects/pg/index.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { catalogsEqual } from "../src/tooling/migrate/equal.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

const provenance: Provenance = { origin: "file", name: "database" };
const namespace = staticNamespace("public");
const gate = await loadPostgresGate();

postgresTest(
  gate,
  "scratch comparison reprints one expression and rejects another",
  async () => {
    await withPostgresSchema(async (sql) => {
      const runner = queryOf(sql);
      const left = await reprintCheck(runner, "id > 0");
      const right = await reprintCheck(runner, "((id > 0))");
      const other = await reprintCheck(runner, "id > 1");
      expect(left).toBe(right);
      expect(left).not.toBe(other);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "introspection drops partition children and inherited indexes",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.parent (id integer primary key) partition by range (id)`,
      );
      await sql.unsafe(
        `create table ${q(schemaName)}.child partition of ${q(schemaName)}.parent for values from (1) to (10)`,
      );
      await sql.unsafe(`create index parent_id_idx on ${q(schemaName)}.parent (id)`);
      const found = await introspectSchema(queryOf(sql), schemaName, "public");
      const names = found.objects
        .filter((object) => object.kind === "table")
        .map((object) => object.identity.name);
      expect(names).toEqual(["parent"]);
      const indexes = found.objects.filter((object) => object.kind === "index");
      expect(indexes.map((object) => object.identity.name)).toEqual(["parent_id_idx"]);
      const keys = found.objects.filter(
        (object) =>
          object.kind === "constraint" && object.definition.constraintKind === "primaryKey",
      );
      expect(keys).toHaveLength(1);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a declared rename round-trips without recreating the check",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({
        tables: [
          defineTable(
            "tasks",
            { id: t.identity(), email: t.text() },
            { checks: { present: (columns) => sqlText`${columns.email} <> ''` } },
          ),
        ],
      });
      const after = schema({
        tables: [
          defineTable(
            "tasks",
            { id: t.identity(), contact: t.text().renamedFrom("email") },
            { checks: { present: (columns) => sqlText`${columns.contact} <> ''` } },
          ),
        ],
      });
      await apply(sql, renderCatalog(before.catalog, schemaName));
      const plan = planMigration({
        before: before.catalog,
        after: after.catalog,
        renames: schemaDeclarations(after).renames,
        schema: schemaName,
        name: "rename",
      });
      expect(plan.steps.some((step) => step.sql.includes("drop constraint"))).toBe(false);
      await apply(
        sql,
        plan.steps.map((step) => step.sql),
      );
      const found = await introspectSchema(queryOf(sql), schemaName, "public");
      const columns = found.objects
        .filter((object) => object.kind === "column")
        .map((object) => object.identity.name);
      expect(columns).toContain("contact");
      expect(columns).not.toContain("email");
      const check = found.objects.find(
        (object) => object.kind === "constraint" && object.definition.constraintKind === "check",
      );
      expect(check?.kind === "constraint" ? check.definition.expression : "").toContain("contact");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "random catalogs and a type change reach the target introspection",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const other = `${schemaName}_b`;
      await sql.unsafe(`create schema ${q(other)}`);
      try {
        for (let seed = 1; seed <= 8; seed += 1) {
          const authoredA = catalog(baseObjects());
          const authoredB = catalog(mutate(baseObjects(), seed));
          await apply(sql, renderCatalog(authoredA, schemaName));
          await apply(sql, renderCatalog(authoredB, other));
          const liveA = await introspectSchema(queryOf(sql), schemaName, "public");
          const liveB = await introspectSchema(queryOf(sql), other, "public");
          const plan = planMigration({
            before: liveA,
            after: liveB,
            schema: schemaName,
            name: `seed-${seed}`,
          });
          expect(
            plan.steps
              .map((step) => step.sql)
              .join("\n")
              .toLowerCase(),
          ).not.toContain("cascade");
          if (seed === 2) {
            const text = plan.steps.map((step) => step.sql).join("\n");
            expect(text).toContain("drop index");
            expect(text).toContain("create index");
          }
          await apply(
            sql,
            plan.steps.map((step) => step.sql),
          );
          const reached = await introspectSchema(queryOf(sql), schemaName, "public");
          expect(catalogsEqual(reached, liveB), serializeCatalog(reached)).toBe(true);
          await sql.unsafe(`drop schema ${q(schemaName)} cascade`);
          await sql.unsafe(`create schema ${q(schemaName)}`);
          await sql.unsafe(`drop schema ${q(other)} cascade`);
          await sql.unsafe(`create schema ${q(other)}`);
        }
      } finally {
        await sql.unsafe(`drop schema if exists ${q(other)} cascade`);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "enum create, add, remove, and many-to-one keep the table readable",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const created = colored(["red", "blue"]);
      await apply(sql, renderCatalog(created.catalog, schemaName));
      const found = await introspectSchema(queryOf(sql), schemaName, "public");
      const labels = enumLabels(found);
      expect(labels).toEqual(["red", "blue"]);
      const status = found.objects.find(
        (object) => object.kind === "column" && object.identity.name === "status",
      );
      expect(
        status?.dependencies.some(
          (edge) => edge.target.kind === "type" && edge.target.name === "color",
        ),
      ).toBe(true);
      await sql.unsafe(`drop table ${q(schemaName)}.tasks`);
      await sql.unsafe(`drop type ${q(schemaName)}.color`);
      await apply(sql, renderCatalog(found, schemaName));
      const round = await introspectSchema(queryOf(sql), schemaName, "public");
      expect(catalogsEqual(found, round)).toBe(true);
      await sql.unsafe(`insert into ${q(schemaName)}.tasks (id, status) values (1, 'red')`);

      const added = colored(["red", "green", "blue"]);
      const addPlan = planMigration({
        before: created.catalog,
        after: added.catalog,
        schema: schemaName,
        name: "add",
      });
      expect(addPlan.steps.some((step) => step.transactional === false)).toBe(true);
      await applyReadable(
        sql,
        schemaName,
        addPlan.steps.map((step) => step.sql),
      );
      await sql.unsafe(`insert into ${q(schemaName)}.tasks (id, status) values (2, 'green')`);
      expect(enumLabels(await introspectSchema(queryOf(sql), schemaName, "public"))).toEqual([
        "red",
        "green",
        "blue",
      ]);

      const removed = colored(["red", "green"]);
      const removePlan = planMigration({
        before: added.catalog,
        after: removed.catalog,
        replacements: [parseReplace("tasks.status.blue=red")],
        schema: schemaName,
        name: "remove",
      });
      let sawContract = false;
      for (const step of removePlan.steps) {
        if (!sawContract && step.class === "contract" && step.action === "backfill") {
          await sql.unsafe(`insert into ${q(schemaName)}.tasks (id, status) values (3, 'blue')`);
          await sql.unsafe(`select status::text from ${q(schemaName)}.tasks`);
          sawContract = true;
        }
        await sql.unsafe(step.sql);
        await sql.unsafe(`select status::text from ${q(schemaName)}.tasks`);
      }
      expect(sawContract).toBe(true);
      const left = await sql.unsafe(
        `select status::text as status from ${q(schemaName)}.tasks order by id`,
      );
      expect(left.map((row) => String(row.status))).toEqual(["red", "green", "red"]);
      expect(enumLabels(await introspectSchema(queryOf(sql), schemaName, "public"))).toEqual([
        "red",
        "green",
      ]);

      await sql.unsafe(`drop table ${q(schemaName)}.tasks`);
      await sql.unsafe(`drop type ${q(schemaName)}.color`);
      const shared = schema({
        tables: [
          defineTable("tasks", {
            id: t.integer(),
            status: t.enum("color", ["red", "blue", "green"]),
            shade: t.enum("color", ["red", "blue", "green"]),
          }),
        ],
      });
      const narrowed = schema({
        tables: [
          defineTable("tasks", {
            id: t.integer(),
            status: t.enum("color", ["red"]),
            shade: t.enum("color", ["red"]),
          }),
        ],
      });
      await apply(sql, renderCatalog(shared.catalog, schemaName));
      await sql.unsafe(
        `insert into ${q(schemaName)}.tasks (id, status, shade) values (1, 'blue', 'green'), (2, 'green', 'blue')`,
      );
      const many = planMigration({
        before: shared.catalog,
        after: narrowed.catalog,
        replacements: [
          parseReplace("tasks.status.blue=red"),
          parseReplace("tasks.status.green=red"),
          parseReplace("tasks.shade.blue=red"),
          parseReplace("tasks.shade.green=red"),
        ],
        schema: schemaName,
        name: "many",
      });
      await applyReadable(
        sql,
        schemaName,
        many.steps.map((step) => step.sql),
      );
      const rows = await sql.unsafe(
        `select status::text as status, shade::text as shade from ${q(schemaName)}.tasks order by id`,
      );
      expect(rows.map((row) => `${String(row.status)}:${String(row.shade)}`)).toEqual([
        "red:red",
        "red:red",
      ]);

      const bare = schema({ tables: [defineTable("tasks", { id: t.integer() })] });
      const drop = planMigration({
        before: narrowed.catalog,
        after: bare.catalog,
        schema: schemaName,
        name: "drop",
      });
      const dropSql = drop.steps.map((step) => step.sql);
      expect(dropSql.findIndex((statement) => statement.includes("drop column"))).toBeLessThan(
        dropSql.findIndex((statement) => statement.startsWith("drop type")),
      );
      await applyReadable(sql, schemaName, dropSql);
      const gone = await introspectSchema(queryOf(sql), schemaName, "public");
      expect(gone.objects.some((object) => object.kind === "type")).toBe(false);
    });
  },
  60_000,
);

function colored(labels: readonly string[]) {
  return schema({
    tables: [defineTable("tasks", { id: t.integer(), status: t.enum("color", labels) })],
  });
}

function enumLabels(source: {
  readonly objects: readonly { readonly kind: string; readonly definition: unknown }[];
}): string[] {
  const object = source.objects.find((item) => item.kind === "type");
  if (object === undefined || !("labels" in (object.definition as object))) return [];
  const labels = (object.definition as { readonly labels?: unknown }).labels;
  return Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === "string")
    : [];
}

async function applyReadable(
  sql: Sql,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await sql.unsafe(statement);
    await sql.unsafe(`select * from ${q(schemaName)}.tasks`);
  }
}

function baseObjects(): CatalogObject[] {
  const users = { namespace, name: "users" };
  const tasks = { namespace, name: "tasks" };
  return [
    table({ namespace, name: "users", provenance }),
    column({ parent: users, name: "id", dataType: "integer", nullable: false, provenance }),
    column({ parent: users, name: "email", dataType: "text", nullable: false, provenance }),
    constraint({ parent: users, constraintKind: "primaryKey", columns: ["id"], provenance }),
    constraint({
      parent: users,
      constraintKind: "unique",
      columns: ["email"],
      nameKey: "email",
      provenance,
    }),
    table({ namespace, name: "tasks", provenance }),
    column({ parent: tasks, name: "id", dataType: "integer", nullable: false, provenance }),
    column({ parent: tasks, name: "owner_id", dataType: "integer", nullable: false, provenance }),
    column({ parent: tasks, name: "title", dataType: "text", nullable: true, provenance }),
    enumType({ namespace, name: "color", labels: ["red", "blue"], provenance }),
    column({
      parent: tasks,
      name: "color",
      dataType: "color",
      nullable: false,
      provenance,
      dependencies: [{ kind: "type", namespace, name: "color" }],
    }),
    constraint({ parent: tasks, constraintKind: "primaryKey", columns: ["id"], provenance }),
    constraint({
      parent: tasks,
      constraintKind: "foreignKey",
      columns: ["owner_id"],
      nameKey: "owner",
      references: { parent: users, columns: ["id"] },
      provenance,
    }),
    index({ parent: tasks, columns: ["title"], nameKey: "title", provenance }),
    constraint({
      parent: tasks,
      constraintKind: "check",
      columns: ["id"],
      nameKey: "id",
      expression: "(id > (0))",
      provenance,
    }),
  ];
}

function mutate(objects: CatalogObject[], seed: number): CatalogObject[] {
  const next = objects.map((object) => object);
  const tasks = { namespace, name: "tasks" };
  if (seed % 5 === 1) {
    next.push(
      column({ parent: tasks, name: "note", dataType: "text", nullable: true, provenance }),
    );
    return next.map((object) => {
      if (object.kind === "type" && object.identity.name === "color") {
        return enumType({
          namespace,
          name: "color",
          labels: ["red", "blue", "green"],
          provenance,
        });
      }
      return object;
    });
  } else if (seed % 5 === 2) {
    return next.map((object) => {
      if (object.kind === "column" && object.identity.name === "title") {
        return column({
          parent: tasks,
          name: "title",
          dataType: "character varying(40)",
          nullable: true,
          provenance,
        });
      }
      return object;
    });
  } else if (seed % 5 === 3) {
    next.push(index({ parent: tasks, columns: ["owner_id"], nameKey: "owner", provenance }));
  } else if (seed % 5 === 4) {
    return next.filter(
      (object) => !(object.kind === "constraint" && object.definition.constraintKind === "check"),
    );
  } else {
    next.push(table({ namespace, name: "labels", provenance }));
    next.push(
      column({
        parent: { namespace, name: "labels" },
        name: "id",
        dataType: "integer",
        nullable: false,
        provenance,
      }),
    );
    next.push(
      constraint({
        parent: { namespace, name: "labels" },
        constraintKind: "primaryKey",
        columns: ["id"],
        provenance,
      }),
    );
  }
  return next;
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

async function apply(sql: Sql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
