/**
 * Invariant J: a target provisioned from the head snapshot matches one that
 * replayed history. Compared by introspection, not by SQL text.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { staticNamespace } from "../catalog/object.js";
import { renderCatalog, type NamespaceBinding } from "../catalog/render.js";
import { quoteIdent } from "../catalog/sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { structuralMismatches } from "../migrations/equal.js";
import { planMigration, planSql } from "../migrations/plan.js";
import { dropEmptyDatabase } from "./admin.js";
import { TargetError } from "./error.js";
import { itemsCatalog, itemsCatalogWithNote, rolesCatalog } from "./fixture.js";
import { formatPostgresUrl, parsePostgresUrl } from "./url.js";
import { introspectNamespace, provisionTarget } from "./provision.js";
import { referenceInserts, type ReferenceDeclaration } from "./reference.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const logical = staticNamespace("app");
const references: readonly ReferenceDeclaration[] = [
  {
    table: "roles",
    key: ["id"],
    rows: [
      { id: "admin", label: "Administrator" },
      { id: "member", label: "Member" },
    ],
  },
];

postgresTest(decision, "provision.equivalence", async () => {
  const admin = openPostgres();
  const suffix = crypto.randomUUID().slice(0, 8);
  const replaySchema = `p08b_rep_${suffix}`;
  const freshSchema = `p08b_new_${suffix}`;
  const dirtySchema = `p08b_dirty_${suffix}`;
  const replayDb = `p08b_drep_${suffix}`;
  const freshDb = `p08b_dnew_${suffix}`;
  try {
    await replaySchemaHistory(admin, replaySchema);
    const fresh = await provisionTarget({
      sql: admin,
      schema: freshSchema,
      snapshot: snapshot(freshSchema),
      references,
      migrationId: "m2",
      catalogHash: "head",
      protected: true,
    });
    console.log(`MEASURE provision.schema ms=${fresh.ms.toFixed(1)}`);
    expect(fresh.history).toEqual(["provisioned@m2"]);
    const replayed = await introspectNamespace(admin, replaySchema, logical);
    const provisioned = await introspectNamespace(admin, freshSchema, logical);
    expect(structuralMismatches(replayed, provisioned)).toEqual([]);
    expect(await roleRows(admin, replaySchema)).toEqual(await roleRows(admin, freshSchema));

    const replayCreate = await timeCreate(admin, replayDb);
    const replay = openPostgres(databaseUrl(replayDb));
    try {
      await replaySchemaHistory(replay, "public");
    } finally {
      await replay.end({ timeout: 5 });
    }
    const freshCreate = await timeCreate(admin, freshDb);
    const created = openPostgres(databaseUrl(freshDb));
    try {
      const database = await provisionTarget({
        sql: created,
        schema: "public",
        snapshot: snapshot("public"),
        references,
        migrationId: "m2",
        catalogHash: "head",
        protected: false,
      });
      console.log(
        `MEASURE provision.database createMs=${freshCreate.toFixed(1)} provisionMs=${database.ms.toFixed(1)} replayCreateMs=${replayCreate.toFixed(1)}`,
      );
      const migrated = openPostgres(databaseUrl(replayDb));
      try {
        const fromHistory = await introspectNamespace(migrated, "public", logical);
        const fromSnapshot = await introspectNamespace(created, "public", logical);
        expect(structuralMismatches(fromHistory, fromSnapshot)).toEqual([]);
      } finally {
        await migrated.end({ timeout: 5 });
      }
    } finally {
      await created.end({ timeout: 5 });
    }

    await admin.unsafe(`create schema ${quoteIdent(dirtySchema)}`);
    await admin.unsafe(`create table ${quoteIdent(dirtySchema)}.junk (id int)`);
    let refused = false;
    try {
      await provisionTarget({
        sql: admin,
        schema: dirtySchema,
        snapshot: snapshot(dirtySchema),
        references,
        migrationId: "m2",
        catalogHash: "head",
        protected: false,
      });
    } catch (error) {
      refused = error instanceof TargetError && error.code === "OKM1851";
    }
    expect(refused).toBe(true);
  } finally {
    for (const schema of [replaySchema, freshSchema, dirtySchema]) {
      await admin.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
    }
    await dropEmptyDatabase(admin, replayDb).catch(() => undefined);
    await dropEmptyDatabase(admin, freshDb).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
});

postgresTest(
  decision,
  "reference rows insert when missing and never update or delete",
  async () => {
    const admin = openPostgres();
    const suffix = crypto.randomUUID().slice(0, 8);
    const schema = `p08b_ref_${suffix}`;
    try {
      const sql = referenceInserts(schema, references);
      expect(sql.some((statement) => /\b(update|delete)\b/i.test(statement))).toBe(false);
      await provisionTarget({
        sql: admin,
        schema,
        snapshot: snapshot(schema),
        references,
        migrationId: "m2",
        catalogHash: "head",
        protected: false,
      });
      await admin.unsafe(
        `update ${quoteIdent(schema)}.roles set label = 'Changed' where id = 'admin'`,
      );
      await admin.unsafe(
        `insert into ${quoteIdent(schema)}.roles (id, label) values ('guest', 'Guest')`,
      );
      const changed: ReferenceDeclaration = {
        table: "roles",
        key: ["id"],
        rows: [
          { id: "admin", label: "Nope" },
          { id: "owner", label: "Owner" },
        ],
      };
      for (const statement of referenceInserts(schema, [changed])) {
        await admin.unsafe(statement);
      }
      expect(await roleRows(admin, schema)).toEqual([
        { id: "admin", label: "Changed" },
        { id: "guest", label: "Guest" },
        { id: "member", label: "Member" },
        { id: "owner", label: "Owner" },
      ]);
    } finally {
      await admin.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
      await admin.end({ timeout: 5 });
    }
  },
);

function snapshot(schema: string): readonly string[] {
  return renderCatalog(head(), bindings(schema));
}

function head() {
  return [...itemsCatalogWithNote(logical), ...rolesCatalog(logical)];
}

function bindings(schema: string): readonly NamespaceBinding[] {
  return [{ logical, concrete: schema }];
}

async function replaySchemaHistory(sql: Sql, schema: string): Promise<void> {
  const before = [...itemsCatalog(logical), ...rolesCatalog(logical)];
  const after = head();
  await sql.unsafe(`create schema if not exists ${quoteIdent(schema)}`);
  for (const statement of renderCatalog(before, bindings(schema))) {
    await sql.unsafe(statement);
  }
  for (const statement of planSql(planMigration(before, after, bindings(schema)))) {
    await sql.unsafe(statement);
  }
  for (const statement of referenceInserts(schema, references)) {
    await sql.unsafe(statement);
  }
}

async function roleRows(
  sql: Sql,
  schema: string,
): Promise<readonly { id: string; label: string }[]> {
  const rows = await sql.unsafe(`select id, label from ${quoteIdent(schema)}.roles order by id`);
  return rows.map((row) => ({ id: text(row.id), label: text(row.label) }));
}

async function timeCreate(admin: Sql, name: string): Promise<number> {
  const started = performance.now();
  await admin.unsafe(`create database ${quoteIdent(name)}`);
  return performance.now() - started;
}

function databaseUrl(name: string): string {
  return formatPostgresUrl({ ...parsePostgresUrl(primaryUrl()), database: name });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}
