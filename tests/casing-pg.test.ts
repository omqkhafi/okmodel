/**
 * Casing on real Postgres.
 *
 * Under `snake` and `camel`, the fixture goes through `okm generate init`,
 * `okm migrate apply`, `okm migrate check`, and `okm check`, and a second
 * `okm generate` finds nothing to write. Then the client runs every runtime
 * emitter against the applied database: path tenancy, archive and cascade,
 * references, sequences, the touch trigger, and views.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tenantPolicyExpression } from "../src/contracts/catalog/policy.js";
import type { Casing } from "../src/dialects/pg/casing.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { run } from "../src/tooling/migrate/commands.js";
import { columnFixture, rlsFixture, spell } from "./casing-fixture.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const fixture = JSON.stringify(join(root, "tests/casing-fixture.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const UNIT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";
const UNIT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";
const ACCOUNT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c31";
const TASK_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41";
const TASK_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c42";

for (const casing of ["snake", "camel"] as const) {
  postgresTest(
    gate,
    `${casing}: generate, apply, check, and a second generate find no changes`,
    async () => {
      for (const [name, build] of [
        ["columnFixture", columnFixture],
        ["rlsFixture", rlsFixture],
      ] as const) {
        const database = await createIsolatedDatabase();
        const cwd = project(database.url, name, casing);
        try {
          const lines = await cycle(cwd);
          expect(lines.at(-1)).toBe("no changes\n");
          const expected = build(casing).catalog.objects.filter(
            (object) => object.kind === "table",
          );
          const sql = openPostgres(database.url);
          try {
            const rows = await sql<{ relname: string }[]>`
              select c.relname from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and c.relname not like 'okm\\_%'
            `;
            expect(rows.map((row) => row.relname).sort()).toEqual(
              expected.map((object) => object.identity.name).sort(),
            );
          } finally {
            await sql.end({ timeout: 5 });
          }
        } finally {
          rmSync(cwd, { recursive: true, force: true });
          await database.close();
        }
      }
    },
    180_000,
  );

  postgresTest(
    gate,
    `${casing}: the stored policy text is what pg_get_expr prints`,
    async () => {
      const database = await createIsolatedDatabase();
      const cwd = project(database.url, "rlsFixture", casing);
      try {
        await cycle(cwd);
        const sql = openPostgres(database.url);
        try {
          const notes = spell(casing, "userNotes");
          const rows = await sql<{ name: string; expr: string }[]>`
            select p.polname as name, pg_get_expr(p.polqual, p.polrelid) as expr
            from pg_policy p join pg_class c on c.oid = p.polrelid
            where c.relname = ${notes} and p.polname = ${`${notes}_tenant`}
          `;
          expect(rows[0]?.expr).toBe(tenantPolicyExpression(spell(casing, "tenantID"), "uuid"));
        } finally {
          await sql.end({ timeout: 5 });
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    120_000,
  );

  postgresTest(
    gate,
    `${casing}: the client runs path tenancy, archive, sortable, views, and triggers`,
    async () => {
      const app = columnFixture(casing);
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
        try {
          await db.connected;
          const a = db.for({ tenantID: TENANT_A });
          const b = db.for({ tenantID: TENANT_B });
          await a.orgUnits.insert({ id: UNIT_A, displayName: "eng", apiURL: null });
          await b.orgUnits.insert({ id: UNIT_B, displayName: "ops", apiURL: null });

          const touched = await a.orgUnits.update(
            {
              where: { id: UNIT_A },
              set: { displayName: "platform" },
            },
            { returning: true },
          );
          expect(touched).toHaveLength(1);
          const unit = await a.orgUnits.find({ where: { id: UNIT_A }, limit: 1 });
          expect(unit[0]?.displayName).toBe("PLATFORM");
          expect(unit[0]?.updatedAt).toBeDefined();
          expect(unit[0]?.createdAt).toBeDefined();

          await a.userAccounts.insert({
            id: ACCOUNT,
            orgUnitID: UNIT_A,
            emailURL: "https://a.example",
            line2Text: null,
            status: "on",
            score: 3,
          });
          await a.accountNotes.insert({ id: NOTE, accountID: ACCOUNT, htmlBody: "<p>hi</p>" });
          expect(await a.accountNotes.count({})).toBe(1);

          await a.taskItems.insert({ id: TASK_A, unitID: UNIT_A, htmlTitle: "ship" });
          await b.taskItems.insert({ id: TASK_B, unitID: UNIT_B, htmlTitle: "other" });
          const own = await a.taskItems.find({ where: { id: TASK_A }, limit: 5 });
          expect(own.map((row) => row.htmlTitle)).toEqual(["ship"]);
          expect(await a.taskItems.find({ where: { id: TASK_B }, limit: 5 })).toEqual([]);
          expect(await b.taskItems.count({})).toBe(1);

          await a.userAccounts.archive({ where: { id: ACCOUNT } });
          expect(await a.userAccounts.count({})).toBe(0);
          expect(await a.accountNotes.count({})).toBe(0);
          await a.userAccounts.restore({ where: { id: ACCOUNT } });
          expect(await a.userAccounts.count({})).toBe(1);
          expect(await a.accountNotes.count({})).toBe(1);

          await a.boardCards.insert({ id: UNIT_A, laneID: "todo", label: "first" });
          await a.boardCards.insert({ id: UNIT_B, laneID: "todo", label: "second" });
          const cards = await a.boardCards.find({ orderBy: { position: "asc" }, limit: 5 });
          expect(cards.map((row) => row.label)).toEqual(["first", "second"]);

          const scope = db.unscoped("test");
          await scope.auditEntries.insert({ note: "x" });
          const entries = await scope.auditEntries.find({ limit: 5 });
          expect(entries.map((row) => (row as { entryID?: unknown }).entryID)).toHaveLength(1);

          const codes = await db.statusCodes.find({ orderBy: { codeID: "asc" }, limit: 5 });
          expect(codes).toEqual([]);
          const list = await db.views.statusList.find({ limit: 5 });
          expect(list).toEqual([]);
          const emails = await a.views.accountEmails.find({ limit: 5 });
          expect(emails.map((row) => row.emailUrl)).toEqual(["https://a.example"]);
          expect(await b.views.accountEmails.find({ limit: 5 })).toEqual([]);
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

  postgresTest(
    gate,
    `${casing}: apply writes the reference rows under the cased names`,
    async () => {
      const database = await createIsolatedDatabase();
      const cwd = project(database.url, "columnFixture", casing);
      try {
        await cycle(cwd);
        const sql = openPostgres(database.url);
        try {
          const rows = await sql.unsafe(
            `select "${spell(casing, "codeID")}" as code from "${spell(casing, "statusCodes")}" order by 1`,
          );
          expect(rows.map((row) => row.code)).toEqual(["bad", "ok"]);
        } finally {
          await sql.end({ timeout: 5 });
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    120_000,
  );
}

function project(url: string, builder: string, casing: Casing): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-casing-"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { ${builder} } from ${fixture};\nexport const app = ${builder}(${JSON.stringify(casing)});\n`,
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

async function cycle(cwd: string): Promise<string[]> {
  const lines: string[] = [];
  const stdout = (text: string): void => {
    lines.push(text);
  };
  await run(["generate", "init"], { cwd, stdout });
  await run(["migrate", "apply"], { cwd, stdout });
  await run(["migrate", "check"], { cwd, stdout });
  await run(["check"], { cwd, stdout });
  lines.length = 0;
  await run(["generate", "again"], { cwd, stdout });
  return lines;
}
