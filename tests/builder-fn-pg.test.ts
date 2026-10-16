/**
 * Typed function calls and builder views on Postgres.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import {
  fragment,
  ident,
  schema,
  sql as predicate,
  table,
  text,
} from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const notes = table("notes", { id: text().primaryKey(), title: text() });

const gate = await loadPostgresGate();

postgresTest(gate, "a call returns the slug and the builder view is readable", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    const slugify = fn("slugify", {
      schema: schemaName,
      arguments: [{ name: "title", type: "text" }],
      returns: "text",
      language: "sql",
      volatility: "immutable",
      body: predicate`select lower(title)`,
    });
    const active = view("active_notes", (q) =>
      q.from(notes, ["id", "title"]).where(predicate`title is not null`),
    );
    const app = schema({
      tables: [notes],
      functions: [slugify],
      views: [active],
    });
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await db.notes.insert({ id: "n1", title: "Hello" });
      await db.notes.insert({ id: "n2", title: "Other" });
      const rows = await db.notes.find({
        where: { id: fragment`${slugify(ident("title"))} = ${"hello"}` },
        select: ["id", slugify(ident("title")).as("slug")] as const,
        limit: 5,
      });
      expect(rows).toEqual([{ id: "n1", slug: "hello" }]);
      const viewed = await db.views.activeNotes.find({ limit: 5 });
      expect(viewed.map((row) => row.id).sort((left, right) => (left < right ? -1 : 1))).toEqual([
        "n1",
        "n2",
      ]);
    } finally {
      await db.close();
    }
  });
});
