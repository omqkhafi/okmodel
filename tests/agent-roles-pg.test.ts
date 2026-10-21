/**
 * The agent role recipe tokenizes, and its SQL runs on Postgres.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { sqlQuoteOpen, sqlStatements } from "../src/tooling/migrate/sql-lex.js";

const gate = await loadPostgresGate();
const page = readFileSync(join(repoRoot(), "docs/roles.md"), "utf8");

/**
 * SQL fences on the role page, in order.
 *
 * @param markdown - Page source
 * @returns Fence bodies
 */
function sqlBlocks(markdown: string): readonly string[] {
  return [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/**
 * Drops a recipe role after revoking the schema grant that blocks DROP ROLE.
 *
 * @param sql - Harness connection
 * @param role - Role created by this test
 */
async function dropRole(sql: Sql, role: string): Promise<void> {
  await sql.unsafe(`revoke all on schema public from ${role}`).catch(() => undefined);
  await sql.unsafe(`drop role if exists ${role}`);
}

test("every SQL block in docs/roles.md tokenizes, and none sets a session flag", () => {
  const blocks = sqlBlocks(page);
  expect(blocks.length).toBe(2);
  for (const block of blocks) {
    expect(sqlQuoteOpen(block)).toBe(false);
    const statements = sqlStatements(block);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement.length).toBeGreaterThan(0);
    expect(block.toLowerCase()).not.toContain("default_transaction_read_only");
  }
  expect(page).toContain("GRANT pg_read_all_data");
  expect(page).toContain("GRANT CREATE ON SCHEMA public");
  expect(page).toContain("default_transaction_read_only");
  expect(page).toContain("okm protect add");
});

postgresTest(
  gate,
  "the role recipe grants read-all and schema CREATE on Postgres",
  async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const reader = `okm_reader_${suffix}`;
    const migrator = `okm_migrator_${suffix}`;
    await withPostgres(async (sql) => {
      try {
        for (const block of sqlBlocks(page)) {
          const rewritten = block
            .replaceAll("okm_agent_reader", reader)
            .replaceAll("okm_agent_migrator", migrator);
          for (const statement of sqlStatements(rewritten)) {
            await sql.unsafe(statement);
          }
        }
        const rows = await sql.unsafe(
          `select pg_has_role('${reader}', 'pg_read_all_data', 'member') as reader_member,
                  pg_has_role('${migrator}', 'pg_read_all_data', 'member') as migrator_member,
                  has_schema_privilege('${reader}', 'public', 'CREATE') as reader_create,
                  has_schema_privilege('${migrator}', 'public', 'CREATE') as migrator_create`,
        );
        const row = rows[0] as
          | {
              reader_member: boolean;
              migrator_member: boolean;
              reader_create: boolean;
              migrator_create: boolean;
            }
          | undefined;
        expect(row?.reader_member).toBe(true);
        expect(row?.migrator_member).toBe(true);
        expect(row?.reader_create).toBe(false);
        expect(row?.migrator_create).toBe(true);
      } finally {
        await dropRole(sql, migrator);
        await dropRole(sql, reader);
      }
    });
  },
  20_000,
);
