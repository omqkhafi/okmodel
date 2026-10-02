/**
 * Preview installs the head snapshot on a new database. Rehearsal clones a
 * populated database and applies the pending migration there.
 */

import { expect } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { staticNamespace } from "../catalog/object.js";
import { renderCatalog } from "../catalog/render.js";
import { quoteIdent } from "../catalog/sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { structuralMismatches } from "../migrations/equal.js";
import { planMigration, planSql, type MigrationPlan } from "../migrations/plan.js";
import { dropEmptyDatabase } from "./admin.js";
import { applyToTarget } from "./apply.js";
import type { CatalogObject } from "../catalog/object.js";
import { itemsCatalog, itemsCatalogWithNote, rolesCatalog } from "./fixture.js";
import { cloneDatabase, introspectNamespace, provisionTarget } from "./provision.js";
import { referenceInserts, type ReferenceDeclaration } from "./reference.js";
import { formatPostgresUrl, parsePostgresUrl } from "./url.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const logical = staticNamespace("app");
const references: readonly ReferenceDeclaration[] = [
  {
    table: "roles",
    key: ["id"],
    rows: [{ id: "admin", label: "Administrator" }],
  },
];

postgresTest(decision, "snapshot preview equals a fully migrated target", async () => {
  const admin = openPostgres();
  const suffix = crypto.randomUUID().slice(0, 8);
  const replaySchema = `p08b_prev_${suffix}`;
  const previewDb = `p08b_preview_${suffix}`;
  try {
    const before = [...itemsCatalog(logical), ...rolesCatalog(logical)];
    const after = [...itemsCatalogWithNote(logical), ...rolesCatalog(logical)];
    const replayBindings = [{ logical, concrete: replaySchema }];
    await admin.unsafe(`create schema ${quoteIdent(replaySchema)}`);
    for (const statement of renderCatalog(before, replayBindings)) await admin.unsafe(statement);
    for (const statement of planSql(planMigration(before, after, replayBindings))) {
      await admin.unsafe(statement);
    }
    for (const statement of referenceInserts(replaySchema, references))
      await admin.unsafe(statement);

    const createStarted = performance.now();
    await admin.unsafe(`create database ${quoteIdent(previewDb)}`);
    const createMs = performance.now() - createStarted;
    const preview = openPostgres(databaseUrl(previewDb));
    try {
      const installed = await provisionTarget({
        sql: preview,
        schema: "public",
        snapshot: renderCatalog(after, [{ logical, concrete: "public" }]),
        references,
        migrationId: "m2",
        catalogHash: "head",
        protected: false,
      });
      console.log(
        `MEASURE preview.database createMs=${createMs.toFixed(1)} provisionMs=${installed.ms.toFixed(1)}`,
      );
      const migrated = await introspectNamespace(admin, replaySchema, logical);
      const fromPreview = await introspectNamespace(preview, "public", logical);
      expect(structuralMismatches(migrated, fromPreview)).toEqual([]);
      expect(installed.history).toEqual(["provisioned@m2"]);
    } finally {
      await preview.end({ timeout: 5 });
    }
  } finally {
    await admin.unsafe(`drop schema if exists ${quoteIdent(replaySchema)} cascade`);
    await dropEmptyDatabase(admin, previewDb).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
});

postgresTest(decision, "clone rehearsal applies the pending migration to a copy", async () => {
  const admin = openPostgres();
  const suffix = crypto.randomUUID().slice(0, 8);
  const source = `p08b_src_${suffix}`;
  const clone = `p08b_clone_${suffix}`;
  try {
    await admin.unsafe(`create database ${quoteIdent(source)}`);
    const populated = openPostgres(databaseUrl(source));
    const before = [...itemsCatalog(logical), ...rolesCatalog(logical)];
    const after = [...itemsCatalogWithNote(logical), ...rolesCatalog(logical)];
    const bindings = [{ logical, concrete: "public" }];
    for (const statement of renderCatalog(before, bindings)) await populated.unsafe(statement);
    await populated.unsafe(`insert into public.items (id, name) values (1, 'kept')`);
    await populated.end({ timeout: 5 });
    await admin.unsafe(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [source],
    );
    const cloneMs = await cloneDatabase(admin, source, clone);
    console.log(`MEASURE rehearsal.clone ms=${cloneMs.toFixed(1)}`);
    const copy = openPostgres(databaseUrl(clone));
    try {
      const kept = await copy.unsafe(`select id, name from public.items`);
      expect(kept.map((row) => text(row.name))).toEqual(["kept"]);
    } finally {
      await copy.end({ timeout: 5 });
    }
    const notNull = await applyToTarget({
      ...rehearsalTarget(suffix, databaseUrl(clone)),
      steps: pendingSteps(planMigration(before, after, bindings), "strict"),
    });
    expect(notNull.error).toContain("contains null values");
    const applied = await applyToTarget({
      ...rehearsalTarget(suffix, databaseUrl(clone)),
      steps: pendingSteps(planMigration(before, optionalNote(after), bindings), "safe"),
    });
    expect(applied.error).toBeNull();
    expect(applied.durations.length).toBeGreaterThan(0);
    expect(applied.durations.every((step) => step.lock.length > 0 && step.durationMs >= 0)).toBe(
      true,
    );
    console.log(
      `MEASURE rehearsal.steps ${applied.durations.map((step) => `${step.id}:${step.lock}:${step.durationMs.toFixed(1)}ms`).join(",")}`,
    );
    const check = openPostgres(databaseUrl(clone));
    try {
      const rows = await check.unsafe(`select id, name, note from public.items`);
      expect(
        rows.map((row) => ({ id: text(row.id), name: text(row.name), note: row.note })),
      ).toEqual([{ id: "1", name: "kept", note: null }]);
    } finally {
      await check.end({ timeout: 5 });
    }
  } finally {
    await dropEmptyDatabase(admin, clone).catch(() => undefined);
    await dropEmptyDatabase(admin, source).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
});

function optionalNote(objects: readonly CatalogObject[]): CatalogObject[] {
  return objects.map((object) => {
    if (object.kind !== "column" || object.identity.name !== "note") return object;
    return { ...object, definition: { ...object.definition, nullable: true } };
  });
}

function rehearsalTarget(suffix: string, url: string) {
  return {
    targetName: "rehearsal",
    url,
    schema: "public" as const,
    protected: false,
    applicationName: `okm-p08b-reh-${suffix}`,
    catalogHash: "pending",
  };
}

function pendingSteps(plan: MigrationPlan, migrationId: string) {
  return plan.steps.map((step, index) => ({
    id: `${migrationId}-${index}`,
    migrationId,
    sql: step.sql,
    class: "expand" as const,
    transactional: true,
    lock: step.lock.mode,
    scope: "tenant" as const,
  }));
}

function databaseUrl(name: string): string {
  return formatPostgresUrl({ ...parsePostgresUrl(primaryUrl()), database: name });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}
