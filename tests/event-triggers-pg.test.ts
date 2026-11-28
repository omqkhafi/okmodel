/**
 * Event triggers on Postgres.
 *
 * Each test uses its own database. Event triggers are database-wide, so a
 * guard in the shared `okm` database would block other tests. `finally`
 * drops every event trigger, then `close()` drops the database with FORCE.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";
import postgres from "postgres";

import { open } from "../src/adapters/pg/postgresjs.js";
import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog, CatalogObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { auditDdl, enableRls, guardDdl, notifyDdl } from "../src/dialects/pg/event/index.js";
import { resolveRoleTokens } from "../src/dialects/pg/event/tags.js";
import "../src/dialects/pg/event/index.js";
import "../src/dialects/pg/policy.js";
import { eventTriggerType, fn, trigger, triggerType } from "../src/dialects/pg/fn/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  ensureSchemaOwner,
  openPostgres,
  ownerUrl,
  SCHEMA_OWNER,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { accessReport } from "../src/tooling/migrate/access-cmd.js";
import { checkEventTriggers } from "../src/tooling/migrate/event-check.js";
import { planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";
import { runTarget, type RunnableUnit } from "../src/tooling/migrate/runner.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "proof:trigger.event",
  async () => {
    await using(async (sql, url) => {
      const body = "begin end";
      const functions = (["start", "end", "drop", "rewrite"] as const).map((name) =>
        fn(`evt_${name}`, {
          returns: eventTriggerType,
          language: "plpgsql",
          body,
        }),
      );
      const [start, end, drop, rewrite] = functions;
      if (start === undefined || end === undefined || drop === undefined || rewrite === undefined) {
        throw new Error("functions");
      }
      const built = schema({
        tables: [],
        functions,
        triggers: [
          trigger("evt_start", { event: "ddl_command_start", calls: start, enabled: true }),
          trigger("evt_end", { event: "ddl_command_end", calls: end, enabled: false }),
          trigger("evt_drop", { event: "sql_drop", calls: drop, enabled: "replica" }),
          trigger("evt_rewrite", {
            event: "table_rewrite",
            calls: rewrite,
            enabled: "always",
            tags: ["alter table"],
          }),
        ],
      });
      await apply(sql, built.catalog);
      const rows = await sql<{ name: string; event: string; enabled: string; tags: string }[]>`
        select evtname as name, evtevent as event, evtenabled as enabled,
          coalesce(array_to_string(evttags, ','), '') as tags
        from pg_event_trigger
        order by evtname
      `;
      expect(rows.map((row) => [row.name, row.event, row.enabled, row.tags])).toEqual([
        ["evt_drop", "sql_drop", "R", ""],
        ["evt_end", "ddl_command_end", "D", ""],
        ["evt_rewrite", "table_rewrite", "A", "ALTER TABLE"],
        ["evt_start", "ddl_command_start", "O", ""],
      ]);

      const badFn = fn("bad_fn", { returns: eventTriggerType, language: "plpgsql", body });
      const bad = schema({
        tables: [],
        functions: [badFn],
        triggers: [
          trigger("bad_evt", {
            event: "ddl_command_end",
            tags: ["NOT A COMMAND"],
            calls: badFn,
          }),
        ],
      });
      const refused = await reject(checkEventTriggers(url, bad.catalog));
      expect(refused).toBeInstanceOf(OkmError);
      expect(refused.message).toContain("42601");

      await sql.unsafe(
        `create function shared_probe() returns event_trigger language plpgsql as $okm$begin end$okm$`,
      );
      const probe = await reject(
        sql.unsafe(
          `create event trigger shared_probe on ddl_command_end when tag in ('CREATE ROLE') execute function shared_probe()`,
        ),
      );
      expect(codeOf(probe)).toBe("0A000");
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a failing ddl_command_end rolls the DDL back, and start cannot see the object",
  async () => {
    await using(async (sql) => {
      const boom = fn("boom", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin raise exception 'end refused' using errcode = 'P0001'; end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [boom],
          triggers: [trigger("boom_end", { event: "ddl_command_end", calls: boom })],
        }).catalog,
      );
      const failed = await reject(sql.unsafe(`create table rolled (id int)`));
      expect(failed.message).toContain("end refused");
      const left = await sql<{ n: string }[]>`
        select relname as n from pg_class where relname = 'rolled'
      `;
      expect(left).toHaveLength(0);
      await sql.unsafe(`drop event trigger boom_end`);
      await sql.unsafe(`drop function boom()`);

      const blind = fn("blind", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin perform 1 from pg_event_trigger_ddl_commands(); end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [blind],
          triggers: [trigger("blind_start", { event: "ddl_command_start", calls: blind })],
        }).catalog,
      );
      const unseen = await reject(sql.unsafe(`create table unseen (id int)`));
      expect(unseen.message.toLowerCase()).toContain("pg_event_trigger_ddl_commands");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "event triggers fire in alphabetical order",
  async () => {
    const database = await createIsolatedDatabase();
    const notices: string[] = [];
    const sql = postgres(database.url, {
      max: 1,
      onnotice: (notice) => {
        if (notice.message !== undefined) notices.push(notice.message);
      },
    });
    try {
      const a = fn("evt_a", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin raise notice 'fired a'; end",
      });
      const z = fn("evt_z", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin raise notice 'fired z'; end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [z, a],
          triggers: [
            trigger("z_evt", { event: "ddl_command_end", calls: z }),
            trigger("a_evt", { event: "ddl_command_end", calls: a }),
          ],
        }).catalog,
      );
      notices.length = 0;
      await sql.unsafe(`create table ordered (id int)`);
      expect(notices.filter((line) => line.startsWith("fired "))).toEqual(["fired a", "fired z"]);
    } finally {
      await dropEventTriggers(sql).catch(() => undefined);
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "proof:trigger.guardDdl",
  async () => {
    await using(async (sql, url) => {
      await ensureRoles(sql, true);
      await sql.unsafe(`grant decoy to outsider`);
      await sql.unsafe(`grant create, usage on schema public to outsider, migrant`);
      const built = bindRoles(
        schema({
          tables: [],
          triggers: [guardDdl({ block: "manual", allow: ["migration"] })],
        }).catalog,
        { migration: "migrant" },
      );
      await apply(sql, built);
      const outsider = openPostgres(ownerUrl(url, "outsider"));
      const member = openPostgres(ownerUrl(url, "migrant"));
      try {
        const denied = await reject(outsider.unsafe(`create table sneaky (id int)`));
        expect(denied.message).toContain("okm_guard_manual");
        await outsider.unsafe(`set role decoy`);
        const still = await reject(outsider.unsafe(`create table sneaky2 (id int)`));
        expect(still.message).toContain("okm_guard_manual");
        await member.unsafe(`create table allowed (id int)`);
        const found = await sql<{ n: string }[]>`
          select relname as n from pg_class where relname = 'allowed'
        `;
        expect(found).toHaveLength(1);
      } finally {
        await outsider.end({ timeout: 5 });
        await member.end({ timeout: 5 });
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "drops and rewrites pass only while the per-step GUC is set",
  async () => {
    await using(async (sql) => {
      await apply(
        sql,
        schema({
          tables: [table("notes", { id: t.integer() })],
          triggers: [guardDdl({ block: ["drops", "rewrites"] })],
        }).catalog,
      );
      const dropped = await reject(sql.unsafe(`drop table notes`));
      expect(dropped.message).toContain("okm_guard_drops");
      await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('okm.allow_drop', 'true', true)`);
        await tx.unsafe(`drop table notes`);
      });
      const gone = await sql<{ n: string }[]>`
        select relname as n from pg_class where relname = 'notes'
      `;
      expect(gone).toHaveLength(0);
      const belt = await sql<{ v: string | null }[]>`
        select current_setting('okm.allow_drop', true) as v
      `;
      expect(belt[0]?.v === "true").toBe(false);

      await sql.unsafe(`create table notes (id int)`);
      const rewrite = await reject(sql.unsafe(`alter table notes alter column id type bigint`));
      expect(rewrite.message).toContain("okm_guard_rewrites");
      await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('okm.allow_rewrite', 'true', true)`);
        await tx.unsafe(`alter table notes alter column id type bigint`);
      });
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a session GUC is refused without a proven direct connection and does not leak",
  async () => {
    await using(async (_sql, url) => {
      const other = openPostgres(url);
      try {
        const pool = open({ url, max: 1 });
        if (pool.reserve === undefined) throw new Error("reserve");
        const connection = await pool.reserve();
        try {
          const refused = await reject(
            runTarget(
              connection,
              {
                policy: { target: "default", protected: true, allowProtected: true },
                units: [unitOf(concurrentDrop())],
                lockWaitMs: 0,
                lockTimeoutMs: 1_000,
                statementTimeoutMs: 5_000,
              },
              {},
            ),
          );
          expect(refused).toBeInstanceOf(OkmError);
          expect(refused.code).toBe("OKM1931");
          expect(refused.message).toContain("direct");
        } finally {
          await connection.release();
          await pool.close();
        }
        const leaked = await other<{ v: string | null }[]>`
          select current_setting('okm.allow_drop', true) as v
        `;
        expect(leaked[0]?.v === "true").toBe(false);
      } finally {
        await other.end({ timeout: 5 });
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "proof:trigger.enableRls",
  async () => {
    await using(async (sql) => {
      await apply(
        sql,
        schema({
          tables: [],
          triggers: [enableRls({ schemas: ["public"] })],
        }).catalog,
      );
      await sql.unsafe(`create table notes (id int)`);
      await sql.unsafe(`create temp table scratch (id int)`);
      const rows = await sql<{ name: string; on: boolean; force: boolean }[]>`
        select c.relname as name, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname in ('notes', 'scratch')
      `;
      const notes = rows.find((row) => row.name === "notes");
      const scratch = rows.find((row) => row.name === "scratch");
      expect(notes?.on).toBe(true);
      expect(notes?.force).toBe(false);
      expect(scratch?.on).toBe(false);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:trigger.auditDdl",
  async () => {
    await using(async (sql) => {
      await ensureRoles(sql, false);
      const audit = auditDdl();
      const built = bindRoles(
        schema({
          tables: [audit.transactions, audit.commands],
          triggers: [audit],
        }).catalog,
        { migration: "migrant" },
      );
      await apply(sql, built);
      await sql.unsafe(`create table notes (id int)`);
      const wrote = await sql<{ n: string }[]>`select count(*)::text as n from audit.ddl_command`;
      expect(Number(wrote[0]?.n ?? "0")).toBeGreaterThan(0);
      const revoked = await sql<{ ok: boolean }[]>`
        select has_function_privilege('public', 'audit.okm_audit_ddl()', 'execute') as ok
      `;
      expect(revoked[0]?.ok).toBe(false);
      const before = Number(
        (await sql<{ n: string }[]>`select count(*)::text as n from audit.ddl_command`)[0]?.n ??
          "0",
      );
      const rolled = await reject(
        sql.begin(async (tx) => {
          await tx.unsafe(`create table rolled (id int)`);
          throw new Error("roll this command back");
        }),
      );
      expect(rolled.message).toContain("roll this command back");
      const after = Number(
        (await sql<{ n: string }[]>`select count(*)::text as n from audit.ddl_command`)[0]?.n ??
          "0",
      );
      expect(after).toBe(before);
    });
  },
  40_000,
);

postgresTest(
  gate,
  "proof:trigger.notifyDdl",
  async () => {
    await using(async (_sql, url) => {
      const listener = postgres(url, { max: 1, onnotice: () => {} });
      const writer = openPostgres(url);
      let payload = "";
      try {
        await apply(
          writer,
          schema({
            tables: [],
            triggers: [notifyDdl({ channel: "schema_changed", tags: ["CREATE TABLE"] })],
          }).catalog,
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("notify timed out")), 5_000);
          void listener
            .listen("schema_changed", (value) => {
              payload = value;
              clearTimeout(timer);
              resolve();
            })
            .then(() => writer.unsafe(`create table notes (id int)`))
            .catch((error: unknown) => {
              clearTimeout(timer);
              reject(error);
            });
        });
        expect(payload).toContain("CREATE TABLE");
        expect(payload).toContain("notes");
      } finally {
        await dropEventTriggers(writer);
        await writer.end({ timeout: 5 });
        await listener.end({ timeout: 5 });
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:comment.eventTrigger",
  async () => {
    await using(async (sql) => {
      const good = fn("cmt_fn", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [good],
          triggers: [
            trigger("cmt_evt", {
              event: "ddl_command_end",
              calls: good,
              comment: "watches DDL",
            }),
          ],
        }).catalog,
      );
      const rows = await sql<{ description: string }[]>`
        select d.description
        from pg_description d
        join pg_event_trigger e on e.oid = d.objoid
        where e.evtname = 'cmt_evt'
      `;
      expect(rows[0]?.description).toBe("watches DDL");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an event trigger plan round trip is zero steps",
  async () => {
    await using(async (sql) => {
      const good = fn("round_fn", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin end",
      });
      const authored = schema({
        tables: [],
        functions: [good],
        triggers: [
          trigger("round_evt", {
            event: "ddl_command_end",
            tags: ["CREATE TABLE"],
            calls: good,
          }),
        ],
      }).catalog;
      await apply(sql, authored);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const again = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: again, name: "stable" }).steps).toEqual([]);
      const drift = planMigration({ before: authored, after: live, name: "round" }).steps.filter(
        (step) => step.kind?.includes("event-trigger") === true,
      );
      expect(drift).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a plain role cannot create an event trigger",
  async () => {
    await ensureSchemaOwner();
    await using(async (_sql, url) => {
      const good = fn("plain_fn", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin end",
      });
      const built = schema({
        tables: [],
        functions: [good],
        triggers: [trigger("plain_evt", { event: "ddl_command_end", calls: good })],
      }).catalog;
      const refused = await reject(checkEventTriggers(ownerUrl(url, SCHEMA_OWNER), built));
      expect(refused).toBeInstanceOf(OkmError);
      expect(refused.code).toBe("OKM2209");
      expect(refused.message).toContain("neon_superuser");
      expect(refused.message).toContain(SCHEMA_OWNER);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an error raised by an event trigger names the trigger",
  async () => {
    await using(async (sql, url) => {
      await ensureRoles(sql, true);
      await sql.unsafe(`grant create, usage on schema public to outsider`);
      await apply(
        sql,
        bindRoles(
          schema({
            tables: [],
            triggers: [guardDdl({ block: "manual", allow: ["migration"] })],
          }).catalog,
          { migration: "migrant" },
        ),
      );
      const pool = open({ url: ownerUrl(url, "outsider"), max: 1 });
      if (pool.reserve === undefined) throw new Error("reserve");
      const connection = await pool.reserve();
      try {
        const refused = await reject(
          runTarget(
            connection,
            {
              policy: { target: "default", protected: false, allowProtected: false },
              units: [
                unitOf({
                  sql: `create table sneaky (id int)`,
                  class: "expand",
                  kind: "create-table",
                  action: "ddl",
                  lock: "access exclusive",
                  transactional: true,
                }),
              ],
              lockWaitMs: 0,
              lockTimeoutMs: 1_000,
              directPid: "1",
              statementTimeoutMs: 5_000,
            },
            {},
          ),
        );
        expect(refused.message).toContain("okm_guard_manual");
        expect(refused.message).toContain("DROP EVENT TRIGGER");
        expect(refused.message).toContain("DISABLE");
      } finally {
        await connection.release();
        await pool.close();
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a table trigger RAISE does not name enabled event triggers",
  async () => {
    await using(async (sql, url) => {
      const watcher = fn("evt_watch", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [watcher],
          triggers: [trigger("evt_watch", { event: "ddl_command_end", calls: watcher })],
        }).catalog,
      );
      await sql.unsafe(`create table notes (id int)`);
      await sql.unsafe(
        `create function note_raise() returns trigger language plpgsql as $okm$ begin raise exception 'plain boom' using errcode = 'P0001'; end $okm$`,
      );
      await sql.unsafe(
        `create trigger note_raise before insert on notes for each row execute function note_raise()`,
      );
      const pool = open({ url, max: 1 });
      if (pool.reserve === undefined) throw new Error("reserve");
      const connection = await pool.reserve();
      try {
        const refused = await reject(
          runTarget(
            connection,
            {
              policy: { target: "default", protected: false, allowProtected: false },
              units: [
                unitOf({
                  sql: `insert into notes (id) values (1)`,
                  class: "expand",
                  action: "ddl",
                  lock: "row exclusive",
                  transactional: true,
                }),
              ],
              lockWaitMs: 0,
              lockTimeoutMs: 1_000,
              directPid: "1",
              statementTimeoutMs: 5_000,
            },
            {},
          ),
        );
        expect(refused.message).toContain("plain boom");
        expect(refused.message).not.toContain("Enabled event triggers");
      } finally {
        await connection.release();
        await pool.close();
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a custom event trigger RAISE names the enabled trigger",
  async () => {
    await using(async (sql, url) => {
      const custom = fn("custom_evt_fn", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin raise exception 'custom refused' using errcode = 'P0001'; end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [custom],
          triggers: [trigger("custom_evt", { event: "ddl_command_end", calls: custom })],
        }).catalog,
      );
      const pool = open({ url, max: 1 });
      if (pool.reserve === undefined) throw new Error("reserve");
      const connection = await pool.reserve();
      try {
        const refused = await reject(
          runTarget(
            connection,
            {
              policy: { target: "default", protected: false, allowProtected: false },
              units: [
                unitOf({
                  sql: `create table sneaky (id int)`,
                  class: "expand",
                  kind: "create-table",
                  action: "ddl",
                  lock: "access exclusive",
                  transactional: true,
                }),
              ],
              lockWaitMs: 0,
              lockTimeoutMs: 1_000,
              directPid: "1",
              statementTimeoutMs: 5_000,
            },
            {},
          ),
        );
        expect(refused.message).toContain("custom refused");
        expect(refused.message).not.toContain("okm_guard");
        expect(refused.message).toContain("Enabled event triggers");
        expect(refused.message).toContain("custom_evt");
        expect(refused.message).toContain("DROP EVENT TRIGGER");
      } finally {
        await connection.release();
        await pool.close();
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "okm access labels a declared event trigger and says when the schema was not loaded",
  async () => {
    await using(async (sql, url) => {
      const good = fn("access_fn", {
        returns: eventTriggerType,
        language: "plpgsql",
        body: "begin end",
      });
      await apply(
        sql,
        schema({
          tables: [],
          functions: [good],
          triggers: [trigger("access_evt", { event: "ddl_command_end", calls: good })],
        }).catalog,
      );
      await sql.unsafe(
        `create function stray_fn() returns event_trigger language plpgsql as $okm$ begin end $okm$`,
      );
      await sql.unsafe(
        `create event trigger stray_evt on ddl_command_end execute function stray_fn()`,
      );
      const roles = {
        schema: "./schema.ts",
        roles: {
          migration: { name: "okm_migrate" },
          app: { name: "okm_app" },
        },
      };
      const bare = await accessReport(roles, url, "okm_app");
      expect(bare.eventTriggers).toContain("access_evt unmanaged");
      expect(bare.eventTriggers).toContain("stray_evt unmanaged");
      expect(bare.eventTriggers).toContain("schema was not loaded");
      const cwd = accessProject();
      try {
        const loaded = await accessReport(roles, url, "okm_app", {
          cwd,
          configPath: join(cwd, "okmodel.config.ts"),
        });
        expect(loaded.eventTriggers).toContain("access_evt declared");
        expect(loaded.eventTriggers).toContain("stray_evt unmanaged");
        expect(loaded.eventTriggers).not.toContain("schema was not loaded");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a concurrent session is refused while apply holds the guard",
  async () => {
    await using(async (sql, url) => {
      await ensureRoles(sql, true);
      await sql.unsafe(`grant create, usage on schema public to outsider`);
      await apply(
        sql,
        bindRoles(
          schema({
            tables: [],
            triggers: [guardDdl({ block: "manual", allow: ["migration"] })],
          }).catalog,
          { migration: "migrant" },
        ),
      );
      const outsider = openPostgres(ownerUrl(url, "outsider"));
      try {
        const pending = reject(outsider.unsafe(`create table side (id int)`));
        await sql.unsafe(`create table main (id int)`);
        const denied = await pending;
        expect(denied.message).toContain("okm_guard_manual");
        const main = await sql<{ n: string }[]>`
          select relname as n from pg_class where relname = 'main'
        `;
        expect(main).toHaveLength(1);
      } finally {
        await outsider.end({ timeout: 5 });
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "proof:trigger.referencing",
  async () => {
    await using(async (sql) => {
      const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
      const seen = table("seen", { n: t.integer(), kind: t.text() });
      const audit = fn("audit_rows", {
        returns: triggerType,
        language: "plpgsql",
        dependsOn: [notes, seen],
        body: `begin
          if tg_op = 'INSERT' then
            insert into seen (n, kind) select count(*)::int, 'insert' from new_rows;
          elsif tg_op = 'UPDATE' then
            insert into seen (n, kind) select count(*)::int, 'update' from new_rows;
          elsif tg_op = 'DELETE' then
            insert into seen (n, kind) select count(*)::int, 'delete' from old_rows;
          end if;
          return null;
        end`,
      });
      const built = schema({
        tables: [notes, seen],
        functions: [audit],
        triggers: [
          trigger("notes_insert", {
            on: notes,
            timing: "after",
            events: ["insert"],
            level: "statement",
            referencing: { new: "new_rows" },
            calls: audit,
          }),
          trigger("notes_update", {
            on: notes,
            timing: "after",
            events: ["update"],
            level: "statement",
            referencing: { old: "old_rows", new: "new_rows" },
            calls: audit,
          }),
          trigger("notes_delete", {
            on: notes,
            timing: "after",
            events: ["delete"],
            level: "statement",
            referencing: { old: "old_rows" },
            calls: audit,
          }),
        ],
      });
      await apply(sql, built.catalog);
      await sql.unsafe(`insert into notes (id, title) values (1, 'a'), (2, 'b')`);
      await sql.unsafe(`update notes set title = 'c' where id = 1`);
      await sql.unsafe(`delete from notes where id = 2`);
      const rows = await sql<{ kind: string; n: number }[]>`
        select kind, n from seen order by kind
      `;
      expect(rows.map((row) => ({ kind: row.kind, n: row.n }))).toEqual([
        { kind: "delete", n: 1 },
        { kind: "insert", n: 2 },
        { kind: "update", n: 1 },
      ]);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const names = live.objects
        .filter((object) => object.kind === "trigger")
        .map((object) => (object.kind === "trigger" ? object.definition.referencing : undefined));
      expect(names).toContainEqual({ new: "new_rows" });
      const again = await introspectSchema(queryOf(sql), "public", "public");
      const drift = planMigration({ before: live, after: again, name: "ref" }).steps.filter(
        (step) => step.sql.toLowerCase().includes("referencing"),
      );
      expect(drift).toEqual([]);
    });
  },
  40_000,
);

postgresTest(
  gate,
  "event triggers are created last and a direct apply resets a session belt",
  async () => {
    await using(async (sql, url) => {
      await sql.unsafe(`create table notes (id int)`);
      await sql.unsafe(`create index notes_id on notes (id)`);
      const report = await applyTarget({
        url,
        target: "default",
        protected: false,
        allowProtected: true,
        migrations: [
          {
            id: "drop-idx",
            catalogHash: "evt",
            steps: [concurrentDrop()],
          },
        ],
      });
      expect(report.applied).toEqual(["drop-idx"]);
      const belt = await sql<{ v: string | null }[]>`
        select current_setting('okm.allow_drop', true) as v
      `;
      expect(belt[0]?.v === "true").toBe(false);
    });
  },
  40_000,
);

/**
 * Applies a catalog from an empty database.
 *
 * @param sql - Connection on the isolated database
 * @param after - Catalog to create
 */
async function apply(sql: Sql, after: Catalog): Promise<void> {
  const plan = planMigration({ before: catalog([]), after, name: "apply" });
  for (const step of plan.steps) {
    try {
      await sql.unsafe(step.sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${step.kind ?? "sql"}: ${message}\n${step.sql}`);
    }
  }
}

/**
 * Replaces `{okm_role:key}` with the configured SQL role.
 *
 * @param source - Catalog from `schema()`
 * @param names - Role key to SQL name
 * @returns A catalog the planner can emit
 */
function bindRoles(source: Catalog, names: Readonly<Record<string, string>>): Catalog {
  const map = new Map(Object.entries(names));
  const objects = source.objects.map((object): CatalogObject => {
    if (object.kind === "function") {
      const owned = object.definition.ownedBy;
      return {
        ...object,
        definition: {
          ...object.definition,
          body: resolveRoleTokens(object.definition.body, map, object.identity.name),
          ...(owned === undefined
            ? {}
            : { ownedBy: resolveRoleTokens(owned, map, object.identity.name) }),
        },
      };
    }
    if (object.kind === "eventTrigger" && object.definition.ownedBy !== undefined) {
      return {
        ...object,
        definition: {
          ...object.definition,
          ownedBy: resolveRoleTokens(object.definition.ownedBy, map, object.identity.name),
        },
      };
    }
    return object;
  });
  return catalog(objects);
}

/**
 * Runs `body` on a new database and always drops its event triggers.
 *
 * @param body - Test body. Receives the connection and its URL
 */
async function ensureRoles(sql: Sql, login: boolean): Promise<void> {
  const migrant = login ? "login password 'okm'" : "nologin";
  await sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'migrant') then
      create role migrant ${migrant};
    end if;
    if not exists (select 1 from pg_roles where rolname = 'outsider') then
      create role outsider login password 'okm';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'decoy') then
      create role decoy nologin;
    end if;
  end $$`);
}

/**
 * A project whose schema declares `access_evt`.
 *
 * @returns The project directory. The caller deletes it
 */
function accessProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-access-evt-"));
  const root = repoRoot();
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const fns = JSON.stringify(join(root, "src/dialects/pg/fn/index.ts"));
  const event = JSON.stringify(join(root, "src/dialects/pg/event/index.ts"));
  const config = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema } from ${pg};`,
      `import { eventTriggerType, fn, trigger } from ${fns};`,
      `import ${event};`,
      `const good = fn("access_fn", { returns: eventTriggerType, language: "plpgsql", body: "begin end" });`,
      `const declared = trigger("access_evt", { event: "ddl_command_end", calls: good });`,
      `export const app = schema({ tables: [], functions: [good], triggers: [declared] });`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${config};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      "  roles: {",
      '    migration: { name: "okm_migrate" },',
      '    app: { name: "okm_app" },',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

async function using(body: (sql: Sql, url: string) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql, database.url);
  } finally {
    await dropEventTriggers(sql).catch(() => undefined);
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

/**
 * Drops every event trigger on this connection.
 *
 * @param sql - Connection that can drop them
 */
async function dropEventTriggers(sql: Sql): Promise<void> {
  const rows = await sql<{ evtname: string }[]>`select evtname from pg_event_trigger`;
  for (const row of rows) {
    await sql.unsafe(`drop event trigger if exists ${quoteIdent(row.evtname)}`);
  }
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

function concurrentDrop(): PlanStep {
  return {
    sql: "drop index concurrently if exists notes_id",
    class: "contract",
    kind: "drop-index",
    action: "ddl",
    lock: "share update exclusive",
    transactional: false,
  };
}

function unitOf(step: PlanStep): RunnableUnit {
  return {
    migrationId: "evt",
    catalogHash: "evt",
    finishes: true,
    transactional: step.transactional,
    steps: [{ index: 0, step }],
  };
}

async function reject(run: Promise<unknown>): Promise<OkmError & { code?: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof OkmError) return error;
    if (error instanceof Error) return error as OkmError;
    throw error;
  }
  throw new Error("expected a rejection");
}

function codeOf(error: Error): string {
  if ("code" in error && typeof error.code === "string") return error.code;
  return "";
}
