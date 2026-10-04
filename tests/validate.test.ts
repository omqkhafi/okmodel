/**
 * Validation rules, OKM1030, Standard Schema, and branded skip.
 *
 * These tests do not open a database. The write path is covered in
 * `validate-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError, type ValidationIssue } from "../src/contracts/index.js";
import { integer, schema, table, text, uuid, varchar } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { v } from "../src/runtime/validate/index.js";
import { assertValidation } from "../src/runtime/validate/places.js";

const ID = "11111111-1111-4111-8111-111111111111";

async function rejection(value: unknown): Promise<OkmError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

type Checked = {
  validate<T>(body: T): Promise<T>;
  check(body: unknown): Promise<readonly ValidationIssue[]>;
  pick(...fields: string[]): {
    validate(body: unknown): Promise<unknown>;
    check(body: unknown): Promise<readonly ValidationIssue[]>;
  };
  omit(...fields: string[]): {
    validate(body: unknown): Promise<unknown>;
    check(body: unknown): Promise<readonly ValidationIssue[]>;
  };
};

function checked<T extends { readonly insert: object; readonly update: object }>(
  table: T,
): T & {
  readonly insert: T["insert"] & Checked;
  readonly update: T["update"] & { validate<A>(body: A): Promise<A> };
} {
  return table as never;
}

function client<S extends Parameters<typeof createClient>[0]>(built: S) {
  const db = createClient(built, {} as DriverPool, { ownsPool: false });
  void db.connected.catch(() => undefined);
  return db;
}

const tasks = table(
  "tasks",
  {
    id: uuid(),
    title: varchar(8).validate([v.trim(), v.min(1, "title_required")]),
    status: text().picklist(["draft", "active"]),
    qty: integer(),
    email: text()
      .nullable()
      .validate([v.lowercase(), v.email("email_invalid")]),
    secret: text().sensitive(),
    token: text().hidden(),
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

const app = schema({ tables: [tasks], validation: true });

test("OKM1030 rejects a field validated in two places", () => {
  const both = () =>
    assertValidation(
      schema({
        tables: [
          table(
            "tasks",
            { title: text().validate([v.min(1, "title_required")]) },
            { validate: { title: [v.min(1, "title_required")] }, validation: true },
          ),
        ],
      }),
    );
  expect(both).toThrow(OkmError);
  try {
    both();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (!(error instanceof OkmError)) return;
    expect(error.code).toBe("OKM1030");
    expect(error.category).toBe("input");
    expect(error.message).toContain("tasks.title");
  }
});

test("style section rejects a column rule and style inline rejects the section", () => {
  const section = () =>
    assertValidation(
      schema({
        tables: [table("tasks", { title: text().validate([v.min(1, "short")]) })],
        validation: { style: "section" },
      }),
    );
  expect(section).toThrow(OkmError);
  const inline = () =>
    assertValidation(
      schema({
        tables: [table("tasks", { title: text() }, { validate: { title: [v.min(1, "short")] } })],
        validation: { style: "inline" },
      }),
    );
  expect(inline).toThrow(OkmError);
});

test("a Zod-like and a Valibot-like schema validate a field", async () => {
  const zodLike = {
    "~standard": {
      version: 1 as const,
      vendor: "zod-like",
      validate(value: unknown) {
        if (typeof value === "string" && value.length >= 2) return { value };
        return { issues: [{ message: "zod_short" }] };
      },
    },
  };
  const valibotLike = {
    "~standard": {
      version: 1 as const,
      vendor: "valibot-like",
      async validate(value: unknown) {
        if (typeof value === "string" && value.includes("@")) return { value: value.trim() };
        return { issues: [{ message: "valibot_email", path: [{ key: "local" }] }] };
      },
    },
  };
  const built = schema({
    tables: [
      table(
        "tasks",
        {
          title: text().validate(zodLike),
          email: text().validate(valibotLike),
        },
        { validation: true },
      ),
    ],
    validation: true,
  });
  const db = client(built);
  const good = await checked(db.tasks).insert.validate({ title: "ok", email: " a@b.c " });
  expect(good).toMatchObject({ title: "ok", email: "a@b.c" });
  expect(Object.isFrozen(good)).toBe(true);
  const issues = await checked(db.tasks).insert.check({ title: "x", email: "nope" });
  expect(issues).toEqual([
    { path: ["title"], message: "zod_short" },
    { path: ["email", "local"], message: "valibot_email" },
  ]);
});

test("transforms run before checks, and a branded value is not checked again", async () => {
  let seen = 0;
  const built = schema({
    tables: [
      table(
        "tasks",
        {
          title: varchar(8).validate([
            v.min(2, "short"),
            v.trim(),
            v.rule(
              () => {
                seen += 1;
                return true;
              },
              "title",
              "counted",
            ),
          ]),
        },
        { validation: true },
      ),
    ],
    validation: true,
  });
  const db = client(built);
  const issues = await checked(db.tasks).insert.check({ title: "  a" });
  expect(issues).toEqual([{ path: ["title"], message: "short" }]);
  expect(seen).toBe(1);
  const value = await checked(db.tasks).insert.validate({ title: "  ab  " });
  expect(value).toMatchObject({ title: "ab" });
  expect(seen).toBe(2);
  await checked(db.tasks).insert.validate(value);
  expect(seen).toBe(2);
});

test("onInsert and onUpdate limit rules", async () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        {
          title: text().validate([
            v.onInsert(),
            v.min(2, "insert_min"),
            v.onUpdate(),
            v.min(4, "update_min"),
          ]),
        },
        { validation: true },
      ),
    ],
    validation: true,
  });
  const db = client(built);
  expect(await checked(db.tasks).insert.check({ title: "ab" })).toEqual([]);
  expect(await checked(db.tasks).insert.check({ title: "a" })).toEqual([
    { path: ["title"], message: "insert_min" },
  ]);
  expect(await checked(db.tasks).update.validate({ title: "abcd" })).toMatchObject({
    title: "abcd",
  });
  const failed = await rejection(checked(db.tasks).update.validate({ title: "abc" }));
  expect(failed.code).toBe("OKM1200");
  expect(failed.issues).toEqual([{ path: ["title"], message: "update_min" }]);
});

test("check returns issues in column order and does not throw OKM1200", async () => {
  const db = client(app);
  const issues = await checked(db.tasks).insert.check({
    id: ID,
    title: "  too-long!",
    status: "nope",
    qty: 1.5,
    email: "Nope",
    secret: "s3cret-value",
    token: "hide-me",
  });
  expect(issues.map((issue) => issue.message)).toEqual([
    "too_long",
    "picklist",
    "integer_range",
    "email_invalid",
  ]);
  const text = JSON.stringify(issues);
  expect(text.includes("s3cret-value")).toBe(false);
  expect(text.includes("hide-me")).toBe(false);
  const failed = await rejection(
    checked(db.tasks).insert.validate({ id: ID, secret: "s3cret-value" } as never),
  );
  expect(failed.code).toBe("OKM1200");
  expect(failed.category).toBe("input");
  expect(JSON.stringify(failed).includes("s3cret-value")).toBe(false);
});

test("a guarded field is refused and pick keeps only the named fields", async () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        {
          title: text(),
          note: text().guarded(),
          extra: text().nullable(),
        },
        { validation: true },
      ),
    ],
    validation: true,
  });
  const db = client(built);
  const refused = await rejection(checked(db.tasks).insert.check({ title: "a", note: "nope" }));
  expect(refused.code).toBe("OKM1190");
  const issues = await checked(db.tasks).insert.omit("extra").check({});
  expect(issues).toEqual([{ path: ["title"], message: "required" }]);
  const picked = await checked(db.tasks).insert.pick("extra").check({});
  expect(picked).toEqual([]);
});

test("a list prefixes issues with the row index", async () => {
  const db = client(app);
  const issues = await checked(db.tasks).insert.check([
    {
      id: ID,
      title: "ok",
      status: "draft",
      qty: 0,
      secret: "s3cret-value",
      token: "hide-me",
    },
    { id: ID, status: "draft", qty: 1, secret: "s3cret-value", token: "hide-me" },
  ]);
  expect(issues).toEqual([{ path: [1, "title"], message: "required" }]);
});

test("a table can turn validation on when the schema default is off", async () => {
  await checked(client(app).tasks).insert.check({ title: "ok" });
  expect(app.model.tasks?.validation).toBeDefined();
  const off = schema({ tables: [table("tasks", { title: text() }, { validation: false })] });
  expect(off.model.tasks?.validation).toBeUndefined();
  const inherited = schema({
    tables: [table("tasks", { title: text() }, { validation: true })],
    validation: { enabled: false, onRead: true, style: "section" },
  });
  await checked(client(inherited).tasks).insert.check({ title: "ok" });
  expect(inherited.model.tasks?.validation?.onRead).toBe(true);
});
