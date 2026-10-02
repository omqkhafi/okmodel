/**
 * Editor fixture for the P15 read surface and the P15B write surface.
 *
 * Markers name a hover binding, a completion site, or a diagnostic word.
 * The editor check reads them. This file is excluded from the repository typecheck.
 */

import { eq } from "../../../src/dialects/pg/ops/eq.js";
import { id, uuid } from "../../../src/dialects/pg/keys.js";
import { integer } from "../../../src/dialects/pg/integer.js";
import { schema } from "../../../src/dialects/pg/schema.js";
import { table } from "../../../src/dialects/pg/table.js";
import { text } from "../../../src/dialects/pg/text.js";
import { connect } from "../../../src/runtime/pg/postgresjs.js";

const users = table("users", {
  id: id(),
  email: text(),
  name: text().nullable(),
  role: text().guarded(),
});

const tasks = table("tasks", {
  id: id(),
  ownerId: uuid(),
  title: text(),
  position: integer(),
});

const app = schema({ tables: [users, tasks] });

export async function readRows(url: string): Promise<unknown> {
  const db = connect(url, { schema: app });
  const rows /*@hover rows*/ = await db.users.find({
    where: { /*@complete where*/ email: eq("a@b.c") },
    limit: 1,
  });
  return rows;
}

export async function writeRow(url: string): Promise<unknown> {
  const db = connect(url, { schema: app });
  const created /*@hover created*/ = await db.users.insert({ /*@complete insert*/ email: "a@b.c", name: "Ada" });
  await db.tasks.update({
    where: { title: "ship" },
    set: { /*@complete set*/ position: 1 },
  });
  return created;
}

export async function missingColumn(url: string): Promise<unknown> {
  const db = connect(url, { schema: app });
  /*@diagnostic missing*/
  return db.users.find({ select: ["missing"], limit: 1 });
}

export async function missingTable(url: string): Promise<unknown> {
  const db = connect(url, { schema: app });
  /*@diagnostic missing*/
  return db.missing.find({ limit: 1 });
}
