/**
 * A NOSUPERUSER with CREATE on the schema, and not on the database, cannot
 * run `okm migrate check`. The command creates `okm_check_<uuid>`.
 *
 * The lifecycle property grants that database privilege so the rest of the
 * creator dimension still runs. This file is the minimal repro of the refusal.
 */

import { expect } from "bun:test";

import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import {
  createIsolatedDatabase,
  openPostgres,
  ownerUrl,
} from "../../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { repoRoot } from "../../scripts/root.js";

const gate = await loadPostgresGate();
const ROLE = "okm_creator_strict";

postgresTest(
  gate,
  "a schema-only creator cannot open the migrate-check scratch schema",
  async () => {
    const root = repoRoot();
    const database = await createIsolatedDatabase();
    const project = openLifecycleProject(root, "creator-strict");
    const sql = openPostgres(database.url);
    try {
      const name = decodeURIComponent(new URL(database.url).pathname.replace(/^\//, ""));
      await sql.unsafe(
        `do $$ begin
          if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
            create role ${ROLE} nosuperuser nobypassrls nocreaterole login password 'okm';
          else
            alter role ${ROLE} nosuperuser nobypassrls nocreaterole login password 'okm';
          end if;
        end $$`,
      );
      await sql.unsafe(`grant connect on database ${name} to ${ROLE}`);
      await sql.unsafe(`grant usage, create on schema public to ${ROLE}`);
      project.writeConfig(ownerUrl(database.url, ROLE));
      project.writeSchema(
        [
          `import { schema, t, table } from ${JSON.stringify(`${root}/src/dialects/pg/index.ts`)};`,
          'const tasks = table("tasks", { id: t.identity().primaryKey(), title: t.text() });',
          "export const app = schema({ tables: [tasks] });",
          "",
        ].join("\n"),
      );
      await project.cli(["generate", "init"]);
      let message = "";
      try {
        await project.cli(["migrate", "check"]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("permission denied for database");
    } finally {
      await sql.end({ timeout: 5 });
      project.close();
      await database.close();
    }
  },
  60_000,
);
