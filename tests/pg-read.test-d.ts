/**
 * Result types for find, select, and include.
 */

import { expectTypeOf } from "expect-type";

import { eq, id, integer, many, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const users = table(
  "users",
  { id: id(), email: text(), name: text().nullable() },
  { relations: { tasks: many("tasks") } },
);

const tasks = table(
  "tasks",
  { id: id(), ownerId: uuid().references("users"), title: text(), position: integer() },
  { relations: { owner: one("users") } },
);

const app = schema({ casing: "snake", tables: [users, tasks] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const rows = await db.users.find({
    where: { email: eq("a@b.c") },
    select: ["email", "name"] as const,
    orderBy: { email: "asc" },
    limit: 2,
    include: { tasks: { limit: 1, select: ["title"] as const } },
  });
  type Found = readonly {
    readonly email: string;
    readonly name: string | null;
    readonly tasks: readonly { readonly title: string }[];
  }[];
  expectTypeOf(rows).toMatchTypeOf<Found>();
  expectTypeOf<Found>().toMatchTypeOf(rows);

  const oneRow = await db.tasks.one({
    where: { title: "ship" },
    include: { owner: { select: ["email"] as const } },
  });
  type OneRow = {
    readonly id: string;
    readonly ownerId: string;
    readonly title: string;
    readonly position: number;
    readonly owner: { readonly email: string } | null;
  } | null;
  expectTypeOf(oneRow).toMatchTypeOf<OneRow>();
  expectTypeOf<OneRow>().toMatchTypeOf(oneRow);

  // @ts-expect-error unknown fields are not in the where type
  void db.users.find({ where: { missing: true }, limit: 1 });
}

void shapes;
