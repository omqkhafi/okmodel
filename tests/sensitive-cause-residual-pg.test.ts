/**
 * B-33 residual: postgres.js generic and aborted-connection causes (issue #364).
 *
 * Constraint paths are covered in sensitive-cause-pg.test.ts. These paths omit
 * `table` on the driver error while still attaching `parameters` / `args`.
 */

import { expect } from "bun:test";
import { inspect } from "node:util";
import postgres from "postgres";

import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, id, raw, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const SECRET = "TOPSECRET-RESIDUAL-777";

const secrets = table("secrets_residual", {
  id: id({ default: "none" }),
  secret: text().sensitive(),
});

const plain = table("plain_residual", {
  id: id({ default: "none" }),
  email: text(),
});

const app = schema({ casing: "snake", tables: [secrets, plain] });
const gate = await loadPostgresGate();

function leakNowhere(error: OkmError, value: string): void {
  expect(error.message.includes(value)).toBe(false);
  expect(String(error).includes(value)).toBe(false);
  expect(JSON.stringify(error).includes(value)).toBe(false);
  expect(inspect(error, { depth: 10, showHidden: true }).includes(value)).toBe(false);
  const cause = error.cause;
  if (cause === undefined || cause === null) return;
  expect(inspect(cause, { depth: 10, showHidden: true }).includes(value)).toBe(false);
  expect(JSON.stringify(cause).includes(value)).toBe(false);
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur !== undefined && cur !== null; depth += 1) {
    if (typeof cur !== "object") break;
    expect(String(Reflect.get(cur, "parameters") ?? "").includes(value)).toBe(false);
    expect(String(Reflect.get(cur, "args") ?? "").includes(value)).toBe(false);
    cur = Reflect.get(cur, "cause");
  }
}

class CastRow {
  n = 0;
}

class SleepRow {
  s = "";
}

postgresTest(
  gate,
  "postgresjs: B-33 residual generic driver error strips parameters",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connectPostgres(
        openPostgres({ url: primaryUrl(), searchPath: schemaName, max: 1 }),
        {
          schema: app,
        },
      );
      try {
        await db.connected;
        const failed = await raw(
          db.secrets_residual,
          CastRow,
          "read",
          fragment`select ${SECRET}::int as n`,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(OkmError);
        if (failed instanceof OkmError) {
          expect(failed.kind).toBe("invalid");
          leakNowhere(failed, SECRET);
          expect(failed.cause).not.toHaveProperty("parameters");
          expect(failed.cause).not.toHaveProperty("args");
        }
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "postgresjs: B-33 residual aborted connection strips parameters",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connectPostgres(
        openPostgres({ url: primaryUrl(), searchPath: schemaName, max: 1 }),
        {
          schema: app,
        },
      );
      const admin = postgres(primaryUrl(), { max: 1 });
      try {
        await db.connected;
        const pending = raw(
          db.secrets_residual,
          SleepRow,
          "read",
          fragment`select pg_sleep(30), ${SECRET}::text as s`,
        );
        let pid: number | undefined;
        for (let attempt = 0; attempt < 50 && pid === undefined; attempt += 1) {
          await Bun.sleep(40);
          const rows = await admin`
            select pid
            from pg_stat_activity
            where state = 'active'
              and query like '%pg_sleep(30)%'
              and pid <> pg_backend_pid()
          `;
          const found = rows[0]?.pid;
          if (typeof found === "number") pid = found;
        }
        expect(pid).toBeDefined();
        const killed = await admin`select pg_terminate_backend(${pid!})`;
        expect(killed[0]?.pg_terminate_backend).toBe(true);
        const failed = await pending.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(OkmError);
        if (failed instanceof OkmError) {
          expect(failed.kind).toBe("unavailable");
          leakNowhere(failed, SECRET);
          expect(failed.cause).not.toHaveProperty("parameters");
          expect(failed.cause).not.toHaveProperty("args");
        }
      } finally {
        await db.close().catch(() => undefined);
        await admin.end({ timeout: 1 });
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "postgresjs: B-33 residual plain table generic error keeps parameters",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connectPostgres(
        openPostgres({ url: primaryUrl(), searchPath: schemaName, max: 1 }),
        {
          schema: app,
        },
      );
      try {
        await db.connected;
        const email = "ada@example.com";
        const failed = await raw(
          db.plain_residual,
          CastRow,
          "read",
          fragment`select ${email}::int as n`,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(OkmError);
        if (failed instanceof OkmError) {
          expect(failed.kind).toBe("invalid");
          expect(inspect(failed.cause, { depth: 10, showHidden: true })).toContain(email);
        }
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
