/**
 * The Waiting for locks page matches what apply prints against a real Postgres.
 *
 * The failure text and the `--json` fields in the page are compared with a
 * run that a second connection blocks. Numbers that change per run (pid, age,
 * attempts, time) are masked on both sides.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { errorBody } from "../src/tooling/errors/body.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";

const page = readFileSync(
  join(import.meta.dir, "..", "site/content/docs/migrations/waiting-for-locks.mdx"),
  "utf8",
);
const gate = await loadPostgresGate();

function fence(language: string): string {
  const found = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``).exec(page);
  if (found?.[1] === undefined) throw new Error(`the page has no ${language} block`);
  return found[1];
}

function mask(text: string): string {
  return text
    .replace(/after \d+ attempts? over [\d.]+ (?:ms|s)/g, "after <n> attempts over <time>")
    .replace(/pid (?:\d+|<pid>)/g, "pid <pid>")
    .replace(/for (?:[\d.]+ (?:ms|s|min)(?: \d+ s)?|<age>)/g, "for <age>");
}

postgresTest(
  gate,
  "the failure text and the json fields on the page are what apply prints",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table "${schemaName}".held (id integer)`);
      await sql.unsafe("set application_name = 'lock-holder'");
      await sql.unsafe("begin");
      await sql.unsafe(`lock table "${schemaName}".held in access exclusive mode`);
      let error: unknown;
      try {
        await applyTarget({
          url: primaryUrl(),
          target: schemaName,
          protected: false,
          searchPath: schemaName,
          lockTimeoutMs: 200,
          lockWaitMs: 800,
          migrations: [
            {
              id: "0001_alter",
              catalogHash: "hash",
              steps: [
                {
                  sql: `alter table "${schemaName}".held add column note integer`,
                  class: "expand",
                  action: "ddl",
                  lock: "ACCESS EXCLUSIVE",
                  transactional: true,
                },
              ],
            },
          ],
        });
      } catch (caught) {
        error = caught;
      } finally {
        await sql.unsafe("rollback");
      }
      const message = (error as Error).message;
      expect(mask(message).trim()).toBe(mask(fence("text")).trim());
      const documented = JSON.parse(fence("json")) as Record<string, unknown>;
      const body = errorBody(error) as unknown as Record<string, unknown>;
      for (const key of Object.keys(documented)) expect(Object.keys(body)).toContain(key);
      const live = (body.blockedBy as Record<string, unknown>[])[0] ?? {};
      const shown = (documented.blockedBy as Record<string, unknown>[])[0] ?? {};
      expect(Object.keys(live)).toEqual(Object.keys(shown));
      expect(live.kind).toBe(shown.kind);
      expect(live.state).toBe(shown.state);
      expect(live.application).toBe(shown.application);
    });
  },
  30_000,
);
