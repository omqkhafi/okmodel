/**
 * The scratch checker returns Postgres's own verdict, on PGlite and on a
 * provisioned database.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { checkScratch, type ScratchVerdict } from "../src/tooling/migrate/scratch-check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";

const gate = await loadPostgresGate();

const TABLE = "create table t (a timestamptz, s text, n integer)";

function refusal(verdict: ScratchVerdict): {
  sqlstate: string;
  statement: string;
  error: OkmError;
} {
  if (verdict.ok) throw new Error("expected a refusal");
  return verdict;
}

test("proof:tooling.scratchCheck", async () => {
  expect(
    await checkScratch([
      TABLE,
      "create index t_lower on t ((lower(s)))",
      "alter table t add column d integer generated always as (n * 2) stored",
    ]),
  ).toEqual({ ok: true });
});

test("now() in an index expression is 42P17", async () => {
  const verdict = refusal(await checkScratch([TABLE, "create index t_now on t ((now()))"]));
  expect(verdict.sqlstate).toBe("42P17");
  expect(verdict.error.code).toBe("OKM1848");
  expect(verdict.error.message).toContain("must be marked IMMUTABLE");
  expect(verdict.error.fix.summary).toContain("immutable");
});

test("to_char of a timestamptz in a generated column is refused", async () => {
  const verdict = refusal(
    await checkScratch([
      TABLE,
      "alter table t add column y text generated always as (to_char(a, 'YYYY')) stored",
    ]),
  );
  expect(verdict.sqlstate).toBe("42P17");
  expect(verdict.statement).toContain("to_char");
});

test("concat() in a generated column is refused", async () => {
  const verdict = refusal(
    await checkScratch([
      TABLE,
      "alter table t add column c text generated always as (concat(s, s)) stored",
    ]),
  );
  expect(verdict.sqlstate).toBe("42P17");
});

test("a missing function is 42883", async () => {
  const verdict = refusal(await checkScratch([TABLE, "create index t_x on t ((no_such_fn(s)))"]));
  expect(verdict.sqlstate).toBe("42883");
  expect(verdict.error.fix.summary).toContain("function");
});

test("nothing from a scratch run is kept", async () => {
  await checkScratch(["create table kept (a integer)"]);
  const verdict = refusal(await checkScratch(["select * from kept"]));
  expect(verdict.sqlstate).toBe("42P01");
});

postgresTest(
  gate,
  "the scratch checker gives the same verdicts on a provisioned database",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const accepted = await checkScratch([TABLE, "create index t_lower on t ((lower(s)))"], {
        url: database.url,
      });
      expect(accepted).toEqual({ ok: true });
      const refused = refusal(
        await checkScratch([TABLE, "create index t_now on t ((now()))"], { url: database.url }),
      );
      expect(refused.sqlstate).toBe("42P17");
      const gone = refusal(await checkScratch(["select * from t"], { url: database.url }));
      expect(gone.sqlstate).toBe("42P01");
    } finally {
      await database.close();
    }
  },
);
