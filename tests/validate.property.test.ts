/**
 * Random bodies against an independent model of the same rules.
 *
 * Accept, reject, and issue order match `insert.check`.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { ValidationIssue } from "../src/contracts/index.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { schema, table, text, integer, varchar } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { v } from "../src/runtime/validate/index.js";

function rules<T extends { readonly insert: object }>(
  source: T,
): T & {
  readonly insert: T["insert"] & {
    check(body: unknown): Promise<readonly ValidationIssue[]>;
  };
} {
  return source as never;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Body = {
  readonly title?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly qty?: number | string | null | undefined;
  readonly email?: string | null | undefined;
};

const tasks = table(
  "tasks",
  {
    title: varchar(8).validate([v.trim(), v.min(1, "title_required")]),
    status: text().picklist(["draft", "active"]),
    qty: integer(),
    email: text()
      .nullable()
      .validate([v.lowercase(), v.email("email_invalid")]),
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

const db = createClient(schema({ tables: [tasks], validation: true }), {} as DriverPool, {
  ownsPool: false,
});
void db.connected.catch(() => undefined);

function model(body: Body): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const row: { status?: string; qty?: number; email?: string | null; title?: string } = {};
  if (body.title === undefined) issues.push({ path: ["title"], message: "required" });
  else if (body.title === null) issues.push({ path: ["title"], message: "required" });
  else {
    const title = body.title.trim();
    row.title = title;
    const length = titleLength(title);
    if (length > 8) issues.push({ path: ["title"], message: "too_long" });
    if (length < 1) issues.push({ path: ["title"], message: "title_required" });
  }
  if (body.status === undefined) issues.push({ path: ["status"], message: "required" });
  else if (body.status === null) issues.push({ path: ["status"], message: "required" });
  else {
    row.status = body.status;
    if (body.status !== "draft" && body.status !== "active") {
      issues.push({ path: ["status"], message: "picklist" });
    }
  }
  if (body.qty === undefined) issues.push({ path: ["qty"], message: "required" });
  else if (body.qty === null) issues.push({ path: ["qty"], message: "required" });
  else {
    row.qty = body.qty as number;
    if (!integerOk(body.qty)) issues.push({ path: ["qty"], message: "integer_range" });
  }
  if (body.email === null) row.email = null;
  else if (typeof body.email === "string") {
    const email = body.email.toLowerCase();
    row.email = email;
    if (!EMAIL.test(email)) issues.push({ path: ["email"], message: "email_invalid" });
  }
  if (row.status === "active" && !((row.qty ?? 0) > 0)) {
    issues.push({ path: ["qty"], message: "qty_required" });
  }
  return issues;
}

function titleLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

function integerOk(value: number | string): boolean {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
  return (
    /^-?\d+$/.test(value) && BigInt(value) >= -2_147_483_648n && BigInt(value) <= 2_147_483_647n
  );
}

function present(body: Body): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (body.title !== undefined) row.title = body.title;
  if (body.status !== undefined) row.status = body.status;
  if (body.qty !== undefined) row.qty = body.qty;
  if (body.email !== undefined) row.email = body.email;
  return row;
}

test("random bodies match the rule model", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record(
        {
          title: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
          status: fc.option(fc.constantFrom("draft", "active", "nope", ""), { nil: undefined }),
          qty: fc.option(
            fc.oneof(
              fc.integer({ min: -40_000, max: 40_000 }),
              fc.double({ min: -5, max: 5, noNaN: true }),
              fc.constant("1"),
            ),
            { nil: undefined },
          ),
          email: fc.option(
            fc.oneof(fc.emailAddress(), fc.string({ maxLength: 12 }), fc.constant(null)),
            {
              nil: undefined,
            },
          ),
        },
        { requiredKeys: [] },
      ),
      async (body) => {
        const issues = await rules(db.tasks).insert.check(present(body));
        expect(issues).toEqual(model(body));
      },
    ),
    { numRuns: 80 },
  );
});
