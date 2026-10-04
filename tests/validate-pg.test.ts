/**
 * Validated writes on real Postgres.
 *
 * A validation failure is thrown before any statement. A sequence bumped by a
 * BEFORE INSERT trigger stays uncalled, and the next insert still commits.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  integer,
  numeric,
  schema,
  smallint,
  table,
  text,
  uuid,
  varchar,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { v } from "../src/runtime/validate/index.js";

function rules<T extends { readonly insert: object }>(
  source: T,
): T & {
  readonly insert: T["insert"] & {
    validate<A>(body: A): Promise<A>;
    check(
      body: unknown,
    ): Promise<
      readonly { readonly path: readonly (string | number)[]; readonly message: string }[]
    >;
  };
} {
  return source as never;
}

const ID = "22222222-2222-4222-8222-222222222222";
const NEXT = "33333333-3333-4333-8333-333333333333";

let counts = 0;

const counted = table(
  "counted",
  {
    id: uuid().primaryKey(),
    title: text().validate([
      v.rule(
        () => {
          counts += 1;
          return counts < 10;
        },
        "title",
        "counted",
      ),
    ]),
  },
  { validation: true },
);

const tasks = table(
  "tasks",
  {
    id: uuid().primaryKey(),
    title: varchar(8).validate([v.trim(), v.min(1, "title_required")]),
    status: text().picklist(["draft", "active"]),
    qty: integer(),
    rank: smallint(),
    total: numeric(4, 2),
    code: uuid(),
    email: text()
      .nullable()
      .validate([v.lowercase(), v.email("email_invalid")]),
    secret: text().sensitive(),
  },
  {
    validation: true,
    validate: {
      $row: [
        v.rule(
          (row: { readonly status?: string; readonly qty?: number }) => {
            return row.status !== "active" || (row.qty ?? 0) > 0;
          },
          "qty",
          "qty_required",
        ),
      ],
    },
  },
);

const loose = table(
  "loose",
  {
    id: uuid().primaryKey(),
    title: text(),
  },
  { validation: false },
);

const app = schema({ tables: [tasks, counted, loose], validation: true });

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "validated insert and update, derived rules, and a skipped branded value",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      await sql.unsafe("create sequence proof_seq");
      await sql.unsafe(
        "create function proof_bump() returns trigger language plpgsql as $$ begin perform nextval('proof_seq'); return new; end $$",
      );
      await sql.unsafe(
        "create trigger proof_bi before insert on tasks for each row execute function proof_bump()",
      );
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const row = {
          id: ID,
          title: "  ship  ",
          status: "active" as const,
          qty: 2,
          rank: 3,
          total: "1.50",
          code: "44444444-4444-4444-8444-444444444444",
          email: "Ada@Example.com",
          secret: "s3cret-value",
        };
        const checked = await rules(db.tasks).insert.validate(row);
        expect(checked).toMatchObject({ title: "ship", email: "ada@example.com" });
        expect(Object.isFrozen(checked)).toBe(true);
        const inserted = await db.tasks.insert(checked);
        expect(inserted.title).toBe("ship");
        expect(inserted.email).toBe("ada@example.com");
        const called = await sql<{ readonly is_called: boolean; readonly last_value: string }[]>`
          select is_called, last_value::text from proof_seq
        `;
        expect(called[0]?.is_called).toBe(true);
        expect(called[0]?.last_value).toBe("1");

        const updated = await db.tasks.update({
          where: { id: ID },
          set: { title: "  next  ", email: "Bea@Example.com" },
        });
        expect(updated.count).toBe(1);
        const again = await db.tasks.one({ where: { id: ID } });
        expect(again?.title).toBe("next");
        expect(again?.email).toBe("bea@example.com");

        const derived = await rules(db.tasks).insert.check({
          id: NEXT,
          title: "123456789",
          status: "nope",
          qty: 1.5,
          rank: 40_000,
          total: "123.45",
          code: "not-a-uuid",
          email: "nope",
          secret: "s3cret-value",
        });
        expect(derived.map((issue) => issue.message)).toEqual([
          "too_long",
          "picklist",
          "integer_range",
          "integer_range",
          "precision",
          "uuid",
          "email_invalid",
        ]);
        expect(JSON.stringify(derived).includes("s3cret-value")).toBe(false);

        const rowRule = await rules(db.tasks).insert.check({
          id: NEXT,
          title: "ok",
          status: "active",
          qty: 0,
          rank: 1,
          total: "1.00",
          code: "44444444-4444-4444-8444-444444444444",
          secret: "s3cret-value",
        });
        expect(rowRule).toEqual([{ path: ["qty"], message: "qty_required" }]);

        counts = 0;
        const branded = await rules(db.counted).insert.validate({ id: NEXT, title: "once" });
        expect(counts).toBe(1);
        await db.counted.insert(branded);
        expect(counts).toBe(1);
        await rules(db.counted).insert.validate(branded);
        expect(counts).toBe(1);

        await db.tasks.insert(
          {
            id: "55555555-5555-4555-8555-555555555555",
            title: "   ",
            status: "draft",
            qty: 1,
            rank: 1,
            total: "1.00",
            code: "44444444-4444-4444-8444-444444444444",
            secret: "s3cret-value",
          },
          { validate: false },
        );
        const raw = await db.tasks.one({ where: { id: "55555555-5555-4555-8555-555555555555" } });
        expect(raw?.title).toBe("   ");

        await db.loose.insert({ id: ID, title: "   " });
        const looseRow = await db.loose.one({ where: { id: ID } });
        expect(looseRow?.title).toBe("   ");

        const before = await sql<
          { readonly is_called: boolean; readonly last_value: string }[]
        >`select is_called, last_value::text from proof_seq`;
        let failed: OkmError | undefined;
        try {
          await db.tasks.insert({
            id: "66666666-6666-4666-8666-666666666666",
            title: "",
            status: "draft",
            qty: 1,
            rank: 1,
            total: "1.00",
            code: "44444444-4444-4444-8444-444444444444",
            secret: "s3cret-value",
          });
        } catch (error) {
          if (error instanceof OkmError) failed = error;
          else throw error;
        }
        expect(failed?.code).toBe("OKM1200");
        expect(failed?.category).toBe("input");
        const after = await sql<{ readonly is_called: boolean; readonly last_value: string }[]>`
          select is_called, last_value::text from proof_seq
        `;
        expect(after[0]?.is_called).toBe(before[0]?.is_called);
        expect(after[0]?.last_value).toBe(before[0]?.last_value);
        const followed = await db.tasks.insert({
          id: "77777777-7777-4777-8777-777777777777",
          title: "ok",
          status: "draft",
          qty: 1,
          rank: 1,
          total: "1.00",
          code: "44444444-4444-4444-8444-444444444444",
          secret: "kept",
        });
        expect(followed.title).toBe("ok");
      } finally {
        await db.close();
      }
    });
  },
  20_000,
);

test("OKM1200 is an input error whose message is keys", () => {
  const error = new OkmError("OKM1200", "Validation failed.", {
    issues: [{ path: ["title"], message: "title_required" }],
  });
  expect(error.kind).toBe("invalid");
  expect(error.category).toBe("input");
});
