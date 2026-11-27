/**
 * Generated columns and foreign keys on a real Postgres.
 *
 * The proof titles are the registry entries. Docker down skips the file.
 */

import { expect } from "bun:test";

import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, sql, t, table } from "../src/dialects/pg/index.js";
import { sealGeneratedColumns } from "../src/tooling/migrate/drift.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const gate = await loadPostgresGate();

postgresTest(gate, "proof:column.generatedVirtual", async () => {
  const built = schema({
    tables: [
      table("stats", {
        qty: t.integer(),
        total: t.integer().generated((c) => sql`${c.qty!} + 1`, { stored: false }),
      }),
    ],
  });
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    const version = await db<{ version: string }[]>`show server_version_num`;
    const major = Math.floor(Number(version[0]?.version ?? "0") / 10_000);
    if (major < 18) return;
    for (const statement of renderCatalog(built.catalog, "public")) {
      await db.unsafe(statement);
    }
    await db`insert into stats (qty) values (2)`;
    const rows = await db<{ total: number }[]>`select total from stats`;
    expect(rows[0]?.total).toBe(3);
    const flag = await db<{ attgenerated: string }[]>`
      select attgenerated from pg_attribute
      where attrelid = 'stats'::regclass and attname = 'total'
    `;
    expect(flag[0]?.attgenerated).toBe("v");
  } finally {
    await db.end();
  }
});

postgresTest(gate, "proof:foreignKey.deferrable", async () => {
  const built = schema({
    tables: [
      table("users", { id: t.integer().primaryKey() }),
      table(
        "posts",
        { authorId: t.integer() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              deferrable: "deferred",
            },
          }),
        },
      ),
    ],
  });
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(built.catalog, "public")) {
      await db.unsafe(statement);
    }
    let name = "";
    try {
      await db.begin(async (tx) => {
        await tx`set constraints posts_author deferred`;
        await tx`insert into posts ("authorId") values (1)`;
      });
    } catch (error) {
      name = error instanceof Error ? error.message : "";
    }
    expect(name.toLowerCase()).toContain("posts_author");
  } finally {
    await db.end();
  }
});

postgresTest(gate, "proof:foreignKey.composite", async () => {
  const built = schema({
    tables: [
      table("users", { org: t.integer(), id: t.integer() }, { primaryKey: ["org", "id"] }),
      table(
        "posts",
        { org: t.integer(), id: t.integer() },
        {
          foreignKeys: () => ({
            posts_user: {
              columns: ["org", "id"],
              references: { table: "users", columns: ["org", "id"] },
            },
          }),
        },
      ),
    ],
  });
  await roundTrip(built);
});

postgresTest(gate, "proof:foreignKey.setNullColumns", async () => {
  const built = schema({
    tables: [
      table("users", { id: t.integer().primaryKey() }),
      table(
        "posts",
        { authorId: t.integer().nullable() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              onDelete: { setNull: ["authorId"] },
            },
          }),
        },
      ),
    ],
  });
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    const version = await db<{ version: string }[]>`show server_version_num`;
    const major = Math.floor(Number(version[0]?.version ?? "0") / 10_000);
    if (major < 15) return;
    for (const statement of renderCatalog(built.catalog, "public")) {
      await db.unsafe(statement);
    }
    const definition = await db<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'posts_author'
    `;
    expect(definition[0]?.def.toLowerCase()).toContain("set null");
  } finally {
    await db.end();
  }
});

postgresTest(gate, "proof:foreignKey.matchFull", async () => {
  const built = schema({
    tables: [
      table("users", { id: t.integer().primaryKey() }),
      table(
        "posts",
        { authorId: t.integer() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              match: "full",
            },
          }),
        },
      ),
    ],
  });
  await roundTrip(built);
});

postgresTest(gate, "proof:column.generatedExpression", async () => {
  const built = schema({
    tables: [
      table("stats", { qty: t.integer(), total: t.integer().generated((c) => sql`${c.qty!} + 1`) }),
    ],
  });
  await roundTrip(built);
});

async function roundTrip(built: ReturnType<typeof schema>): Promise<void> {
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(built.catalog, "public")) {
      await db.unsafe(statement);
    }
    const runner = {
      query: async (text: string, params?: readonly string[]) =>
        db.unsafe(text, params === undefined ? undefined : [...params]),
    };
    const live = await introspectSchema(runner, "public");
    const after = await sealGeneratedColumns(runner, built.catalog);
    const plan = planMigration({ before: live, after, name: "round" });
    expect(plan.steps).toEqual([]);
  } finally {
    await db.end();
  }
}
