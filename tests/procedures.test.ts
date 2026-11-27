/**
 * Procedure declarations without a server.
 *
 * Qualified parameters, commit refusals, OUT decoding, and the warning rules.
 * Postgres execution is in `procedures-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import {
  fn,
  voidType,
  type ProcedureBodyHandle,
  type RoutineType,
} from "../src/dialects/pg/fn/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { decodeProcedureValue, runProcedure } from "../src/runtime/procedure.js";
import { procedureFindings } from "../src/tooling/migrate/procedure-rules.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const accounts = table("accounts", {
  id: t.text().primaryKey(),
  balance: t.integer(),
  account: t.text(),
});

test("a string argument type is refused", () => {
  expect(() =>
    fn("slug", {
      arguments: [{ name: "title", type: "text" as never }],
      returns: t.text(),
      language: "sql",
      body: "select 1",
    }),
  ).toThrow(OkmError);
});

test("returns and volatility are refused on a procedure", () => {
  expect(() =>
    fn("no_returns", {
      kind: "procedure",
      returns: t.integer() as never,
      body: "select 1",
    }),
  ).toThrow(/no return type/);
  expect(() =>
    fn("no_volatility", {
      kind: "procedure",
      volatility: "stable" as never,
      body: "select 1",
    }),
  ).toThrow(/no volatility/);
});

test("commits disagrees with the body, the definer, and BEGIN ATOMIC", () => {
  expect(() =>
    fn("open_tx", {
      kind: "procedure",
      commits: true,
      security: "definer",
      searchPath: "public",
      body: "begin commit; end",
    }),
  ).toThrow(/security definer/);
  expect(() =>
    fn("pathed", {
      kind: "procedure",
      commits: true,
      searchPath: "public",
      body: "begin commit; end",
    }),
  ).toThrow(/search_path/);
  expect(() =>
    fn("atomic_commit", {
      kind: "procedure",
      commits: true,
      body: "begin atomic select 1; end",
    }),
  ).toThrow(/BEGIN ATOMIC/);
  expect(() =>
    fn("silent", {
      kind: "procedure",
      commits: true,
      body: "begin null; end",
    }),
  ).toThrow(/no COMMIT or ROLLBACK/);
  expect(() =>
    fn("unmarked", {
      kind: "procedure",
      body: "begin commit; end",
    }),
  ).toThrow(/without commits: true/);
});

test("a typed body qualifies a parameter that matches a column name", () => {
  const closeOne = fn("close_one", {
    kind: "procedure",
    arguments: [
      { name: "account", type: t.text() },
      { name: "closed", type: t.integer(), mode: "out" },
    ],
    body: (args, query) => {
      const found = query.accounts;
      if (found === undefined) throw new Error("missing accounts");
      return [
        found.update({
          set: { balance: 0 },
          where: { account: args.account },
        }),
        query.sql("select 1"),
      ];
    },
  });
  const app = schema({ tables: [accounts], functions: [closeOne] });
  const body = bodyOf(app.catalog, "close_one");
  expect(body).toContain('"close_one"."account"');
  expect(body.toLowerCase()).toContain("begin atomic");
  expect(body).toContain("select 1");
  expect(body).not.toMatch(/=\s+account\b/);
});

test("a handle body records the table and stays lazy until the catalog is read", () => {
  let ran = false;
  const mark = fn("mark_account", {
    kind: "procedure",
    arguments: [{ name: "account", type: t.text() }],
    language: "plpgsql",
    body: (handle: ProcedureBodyHandle) => {
      ran = true;
      return handle.sql`update ${accounts} set balance = 0 where id = ${handle.arg("account")}`;
    },
  });
  expect(ran).toBe(false);
  const app = schema({ tables: [accounts], functions: [mark] });
  expect(ran).toBe(false);
  void app.catalog;
  expect(ran).toBe(true);
  const body = bodyOf(app.catalog, "mark_account");
  expect(body).toContain('"mark_account"."account"');
  const routine = app.catalog.objects.find(
    (object) => object.kind === "function" && object.identity.name === "mark_account",
  );
  expect(routine?.kind === "function" ? routine.dependencies.length : 0).toBeGreaterThan(0);
});

test("an OUT change is drop plus create, and a body change is create or replace", () => {
  const first = procedureSchema("close_one", t.integer());
  const replaced = procedureSchema("close_one", t.integer(), "select 2");
  const widened = procedureSchema("close_one", t.bigint());
  const replaceSql = sqlOf(first, replaced);
  expect(replaceSql.some((sql) => sql.startsWith("create or replace procedure"))).toBe(true);
  expect(replaceSql.some((sql) => sql.startsWith("drop procedure"))).toBe(false);
  const dropSql = sqlOf(first, widened);
  expect(dropSql.some((sql) => sql.startsWith("drop procedure"))).toBe(true);
  expect(dropSql.some((sql) => sql.startsWith("create procedure"))).toBe(true);
});

test("a kind change drops the function and creates the procedure", () => {
  const asFunction = schema({
    tables: [],
    functions: [
      fn("close_one", {
        arguments: [{ name: "account", type: t.text() }],
        returns: voidType,
        language: "sql",
        body: "select 1",
      }),
    ],
  });
  const asProcedure = schema({
    tables: [],
    functions: [
      fn("close_one", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "sql",
        body: "select 1",
      }),
    ],
  });
  const sql = sqlOf(asFunction.catalog, asProcedure.catalog);
  expect(sql.some((step) => step.startsWith("drop function"))).toBe(true);
  expect(sql.some((step) => step.startsWith("create procedure"))).toBe(true);
});

test("decodeProcedureValue accepts a Date before the codec", () => {
  let wire = "";
  const decoded = decodeProcedureValue(new Date("2020-01-02T03:04:05.000Z"), (value) => {
    wire = value;
    return new Date(value);
  });
  expect(wire).toBe("2020-01-02T03:04:05.000Z");
  expect(decoded).toBeInstanceOf(Date);
  expect(decodeProcedureValue("20", (value) => value)).toBe("20");
  expect(decodeProcedureValue(null, (value) => value)).toBeNull();
});

test("CALL passes NULL::type for every OUT parameter", async () => {
  const sent: string[] = [];
  const session = {
    tx: undefined,
    hookm: undefined,
    pool: {
      execute: async (text: string) => {
        sent.push(text);
        return { rows: [["1", "9"]], notices: [], count: 1, reported: 1 };
      },
    },
  };
  const result = await runProcedure(
    session as never,
    {
      label: "close_one",
      schema: '"public"',
      name: '"close_one"',
      commits: false,
      raises: {},
      arguments: [
        {
          name: "account",
          quoted: '"account"',
          sqlType: "text",
          mode: "in",
          hasDefault: false,
          encode: (value: unknown) => String(value),
          decode: (value: string) => value,
        },
        {
          name: "closed",
          quoted: '"closed"',
          sqlType: "integer",
          mode: "out",
          hasDefault: false,
          encode: (value: unknown) => String(value),
          decode: (value: string) => Number(value),
        },
        {
          name: "units",
          quoted: '"units"',
          sqlType: "bigint",
          mode: "out",
          hasDefault: false,
          encode: (value: unknown) => String(value),
          decode: (value: string) => value,
        },
      ],
    },
    { account: "a" },
    undefined,
  );
  expect(sent[0]).toContain('"closed" => null::integer');
  expect(sent[0]).toContain('"units" => null::bigint');
  expect(sent[0]).toContain('"account" => $1::text');
  expect(result).toEqual({ closed: 1, units: "9" });
});

test("a committing procedure is refused inside a transaction before SQL is sent", async () => {
  let sent = false;
  const session = {
    tx: { depth: 1 },
    hookm: undefined,
    pool: {
      execute: async () => {
        sent = true;
        return { rows: [], notices: [], count: 0, reported: 0 };
      },
    },
  };
  let caught: unknown;
  try {
    await runProcedure(
      session as never,
      {
        label: "take_batch",
        schema: '"public"',
        name: '"take_batch"',
        commits: true,
        raises: {},
        arguments: [],
      },
      {},
      undefined,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  expect(caught instanceof OkmError ? caught.message : "").toContain("2D000");
  expect(sent).toBe(false);
});

test("procedure warnings name the tenant table, the exception commit, and the errcode", () => {
  const tenant = table("accounts", {
    id: t.text().primaryKey(),
    org: t.text(),
  });
  const app = schema({
    tables: [tenant],
    functions: [
      fn("close_tenant", {
        kind: "procedure",
        security: "definer",
        searchPath: "public",
        language: "plpgsql",
        dependsOn: [tenant],
        body: "begin update accounts set org = org; end",
      }),
      fn("commit_handler", {
        kind: "procedure",
        commits: true,
        language: "plpgsql",
        body: "begin exception when others then commit; end",
      }),
      fn("named_state", {
        kind: "procedure",
        language: "plpgsql",
        raises: { standard: "22000" },
        body: "begin null; end",
      }),
    ],
  });
  const codes = procedureFindings(app.catalog, { key: "org" }).map((item) => item.rule.code);
  expect(codes).toContain("OKM2125");
  expect(codes).toContain("OKM2126");
  expect(codes).toContain("OKM2127");
});

test("a function catalog hash does not grow a procedure field", () => {
  const app = schema({
    tables: [],
    functions: [
      fn("answer", {
        returns: t.integer(),
        language: "sql",
        body: "select 1",
      }),
    ],
  });
  const hash = catalogHash(app.catalog);
  const again = schema({
    tables: [],
    functions: [
      fn("answer", {
        returns: t.integer(),
        language: "sql",
        body: "select 1",
      }),
    ],
  });
  expect(catalogHash(again.catalog)).toBe(hash);
  const json = JSON.stringify(app.catalog);
  expect(json).not.toContain('"routine"');
  expect(json).toContain('"returns":"integer"');
});

function procedureSchema(name: string, out: RoutineType, last = "select 1") {
  return schema({
    tables: [accounts],
    functions: [
      fn(name, {
        kind: "procedure",
        arguments: [
          { name: "account", type: t.text() },
          { name: "closed", type: out, mode: "out" },
        ],
        body: (args, query) => {
          const found = query.accounts;
          if (found === undefined) throw new Error("missing accounts");
          return [
            found.update({ set: { balance: 0 }, where: { id: args.account } }),
            query.sql(last),
          ];
        },
      }),
    ],
  }).catalog;
}

function sqlOf(before: Catalog, after: Catalog): string[] {
  return planMigration({ before, after, name: "procedures" }).steps.map((step) => step.sql);
}

function bodyOf(source: Catalog, name: string): string {
  const found = source.objects.find(
    (object) => object.kind === "function" && object.identity.name === name,
  );
  if (found?.kind !== "function") throw new Error(`missing ${name}`);
  return found.definition.body;
}
