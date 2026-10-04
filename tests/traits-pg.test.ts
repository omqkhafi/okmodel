/**
 * Timestamps on real Postgres: the generated columns, insert, and update.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { timestamps } from "../src/runtime/traits/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});

const external = table(
  "external",
  { id: t.text().primaryKey(), name: t.text() },
  { omitDefaults: "owned outside okmodel" },
);

const app = schema({
  casing: "snake",
  traits: [timestamps()],
  tables: [notes, external],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "insert stamps both clocks and update moves only updatedAt",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const columns = await sql<
        { column_name: string; column_default: string | null; is_nullable: string }[]
      >`
        select column_name, column_default, is_nullable
        from information_schema.columns
        where table_schema = ${schemaName}
        order by table_name, ordinal_position
      `;
      const names = columns.map(
        (column) => `${column.column_name}:${column.column_default ?? ""}:${column.is_nullable}`,
      );
      expect(names).toContain("created_at:now():NO");
      expect(names).toContain("updated_at:now():NO");
      expect(names.some((name) => name.startsWith("name:"))).toBe(true);
      expect(columns.filter((column) => column.column_name === "created_at")).toHaveLength(1);

      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const inserted = await db.notes.insert({ id: "1", title: "a" });
        expect(millis(inserted.createdAt)).toBe(millis(inserted.updatedAt));

        await expectCode(
          db.notes.insert({ id: "2", title: "b", createdAt: inserted.createdAt } as never),
          "OKM1190",
        );
        await expectCode(
          db.notes.insert({ id: "2", title: "b", updatedAt: inserted.updatedAt } as never, {
            allow: ["updatedAt"],
          }),
          "OKM1190",
        );

        await sql`select pg_sleep(0.05)`;
        expect(await db.notes.update({ where: { id: "1" }, set: { title: "b" } })).toEqual({
          count: 1,
        });
        const found = await db.notes.find({ where: { id: "1" }, limit: 1 });
        const row = found[0];
        if (row === undefined) throw new Error("expected the updated row");
        expect(row.title).toBe("b");
        expect(millis(row.createdAt)).toBe(millis(inserted.createdAt));
        expect(millis(row.updatedAt)).toBeGreaterThan(millis(inserted.updatedAt));

        await expectCode(
          db.notes.update({ where: { id: "1" }, set: { createdAt: row.updatedAt } } as never, {
            allow: ["createdAt"],
          }),
          "OKM1190",
        );

        await db.external.insert({ id: "e", name: "kept" });
        const outside = await db.external.find({ where: { id: "e" }, limit: 1 });
        expect(outside[0]?.name).toBe("kept");
        expect(outside[0]).not.toHaveProperty("createdAt");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

function millis(instant: { toString(): string }): number {
  return Date.parse(instant.toString());
}

async function expectCode(pending: PromiseLike<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
