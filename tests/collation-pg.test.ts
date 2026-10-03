/**
 * Column collation on real Postgres: create, diff, introspect, and plan.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog, ColumnObject } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { okid } from "../src/runtime/ids/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

const notes = schema({
  tables: [
    table("notes", {
      id: t.id({ default: okid({ prefix: "nt_", sortable: true }) }),
      title: t.text(),
    }),
  ],
});

postgresTest(gate, "create stores collation C", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(notes.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const names = await collations(sql, schemaName);
    expect(names).toEqual([
      { column: "id", collation: "C" },
      { column: "title", collation: "" },
    ]);
  });
});

postgresTest(gate, "introspect records collation C and omits the type default", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    await sql.unsafe(
      `create table ${q(schemaName)}.notes (id text collate "C" primary key, title text not null)`,
    );
    const found = await introspectSchema(queryOf(sql), schemaName, "public");
    expect(columnCollation(found, "id")).toBe("C");
    expect(columnCollation(found, "title")).toBeUndefined();
  });
});

postgresTest(gate, "diff of an introspected table sees a missing collation", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    await sql.unsafe(
      `create table ${q(schemaName)}.notes (id text primary key, title text not null)`,
    );
    const live = await introspectSchema(queryOf(sql), schemaName, "public");
    expect(columnCollation(live, "id")).toBeUndefined();
    expect(catalogHash(live)).not.toBe(catalogHash(notes.catalog));
    const sqlText = planMigration({ before: live, after: notes.catalog, name: "collate" })
      .steps.map((step) => step.sql)
      .join("\n")
      .toLowerCase();
    expect(sqlText).toContain('collate "c"');
  });
});

postgresTest(gate, "plan applies collation C and introspect matches", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    await sql.unsafe(
      `create table ${q(schemaName)}.notes (id text primary key, title text not null)`,
    );
    const before = await introspectSchema(queryOf(sql), schemaName, "public");
    const plan = planMigration({
      before,
      after: notes.catalog,
      schema: schemaName,
      name: "collate",
    });
    for (const step of plan.steps) await sql.unsafe(step.sql);
    const after = await introspectSchema(queryOf(sql), schemaName, "public");
    expect(columnCollation(after, "id")).toBe("C");
    expect(columnCollation(after, "title")).toBeUndefined();
  });
});

async function collations(
  sql: Sql,
  schemaName: string,
): Promise<readonly { readonly column: string; readonly collation: string }[]> {
  const rows = await sql.unsafe(
    `select a.attname as column,
      case
        when a.attcollation = 0 or a.attcollation = ty.typcollation then ''
        else coalesce(col.collname, '')
      end as collation
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type ty on ty.oid = a.atttypid
    left join pg_collation col on col.oid = a.attcollation
    where n.nspname = $1 and c.relname = 'notes' and a.attnum > 0 and not a.attisdropped
    order by a.attnum`,
    [schemaName],
  );
  return rows.map((row) => ({
    column: String(row.column),
    collation: String(row.collation ?? ""),
  }));
}

function columnCollation(source: Catalog, name: string): string | undefined {
  const found = source.objects.find(
    (object): object is ColumnObject => object.kind === "column" && object.identity.name === name,
  );
  return found?.definition.collation;
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

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
