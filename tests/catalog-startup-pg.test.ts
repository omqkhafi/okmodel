/**
 * Introspect then re-plan for a schema that uses every table option.
 *
 * Generated expressions are sealed the way `okm` already reprints them: the
 * server's text is not a migration, and the catalog hash keeps the author text.
 * An exclusion does not come back as the declared element shape. That reprint
 * is the same three steps on main, so this test allows those and nothing else.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { CatalogQuery } from "../src/dialects/pg/introspect.js";
import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { index, schema, sql, t, table } from "../src/dialects/pg/index.js";
import "../src/dialects/pg/policy.js";
import { sequence } from "../src/dialects/pg/seq/index.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { sealGeneratedColumns } from "../src/tooling/migrate/drift.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

function everyOption() {
  return schema({
    casing: "snake",
    tables: [
      table(
        "rooms",
        { id: t.integer().primaryKey(), code: t.text() },
        { comment: "rooms", unique: { code_key: ["id", "code"] } },
      ),
      table(
        "bookings",
        {
          id: t.integer().primaryKey(),
          roomId: t.integer().references("rooms", { onDelete: "cascade" }),
          code: t.text(),
          during: t.tstzrange(),
          active: t.boolean().default(true),
          total: t.integer().generated((columns) => sql`${columns.roomId!} + 1`),
          home: t.composite("stay_address", {
            street: t.text().comment("road"),
            city: t.text(),
          }),
          number: sequence({ start: 10 }).column(),
        },
        {
          comment: "bookings",
          indexes: (columns) => [
            index(columns.roomId).with({ fillfactor: 70 }).comment("room lookup"),
          ],
          checks: { active_room: (columns) => sql`((${columns.active!} = true))` },
          foreignKeys: () => ({
            room: {
              columns: ["roomId", "code"],
              references: { table: "rooms", columns: ["id", "code"] },
              deferrable: "deferred",
              comment: "room link",
            },
          }),
          exclusions: (columns) => ({
            no_double: {
              on: [
                [columns.roomId, "eq"],
                [columns.during, "overlaps"],
              ],
              where: { active: true },
              deferrable: "immediate",
            },
          }),
          policies: () => ({ own: { using: true } }),
        },
      ),
    ],
  });
}

postgresTest(
  gate,
  "introspect then re-plan keeps every table option except the exclusion reprint",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const declared = everyOption();
      await sql.unsafe(
        "do $$ begin create role app nologin; exception when duplicate_object then null; end $$",
      );
      await sql.unsafe("drop extension if exists btree_gist cascade");
      try {
        const plan = planMigration({
          before: catalog([]),
          after: declared.catalog,
          schema: schemaName,
          name: "apply",
        });
        for (const step of plan.steps) {
          const text = step.sql.startsWith("create extension ")
            ? step.sql.replace("create extension ", "create extension if not exists ")
            : step.sql;
          await sql.unsafe(text);
        }
        const query = queryOf(sql);
        const live = await introspectSchema(query, schemaName, "public");
        expect(live.objects.some((object) => object.kind === "policy")).toBe(true);
        expect(live.objects.some((object) => object.kind === "sequence")).toBe(true);
        expect(
          live.objects.some(
            (object) =>
              object.kind === "index" &&
              object.definition.storage !== undefined &&
              Object.keys(object.definition.storage).includes("fillfactor"),
          ),
        ).toBe(true);
        expect(
          live.objects.some(
            (object) =>
              object.kind === "constraint" &&
              object.definition.constraintKind === "foreignKey" &&
              object.definition.deferrable === true,
          ),
        ).toBe(true);
        expect(live.objects.some((object) => object.comment === "bookings")).toBe(true);
        const again = planMigration({
          before: live,
          after: await sealGeneratedColumns(query, declared.catalog),
          schema: schemaName,
          name: "again",
        });
        expect(again.steps.map((step) => step.kind)).toEqual([
          "drop-constraint",
          "add-constraint",
          "validate-constraint",
        ]);
        expect(again.steps.every((step) => step.sql.includes("bookings_no_double_excl"))).toBe(
          true,
        );
      } finally {
        await sql.unsafe("drop extension if exists btree_gist cascade");
      }
    });
  },
  60_000,
);

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
