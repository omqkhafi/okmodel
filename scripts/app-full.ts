/**
 * The startup app with every 0.2 feature in use together.
 *
 * Reported beside the featureless fixture. Not a gate (P30). The app has column
 * tenancy, `archivable()` with a cascade, `timestamps()`, validation rules,
 * `one`, `many` and `manyThrough` relations, presets, and calls `include`,
 * `page`, `aggregate`, `tx` and `batch`. The calls sit in functions that are not
 * run at import, so planners that load on first use stay lazy chunks, as they do
 * in a real app.
 */

import { OkmError } from "../src/contracts/index.js";
import {
  boolean,
  eq,
  gte,
  id,
  integer,
  jsonb,
  many,
  manyThrough,
  numeric,
  one,
  schema,
  table,
  text,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { archivable, timestamps } from "../src/runtime/traits/index.js";
import { v } from "../src/runtime/validate/index.js";

const users = table(
  "users",
  {
    id: id(),
    email: text().validate([v.trim(), v.lowercase()]),
    name: text(),
    active: boolean(),
  },
  { traits: [archivable(), timestamps()], presets: { active: (q) => q.where({ active: true }) } },
);

const orgs = table(
  "orgs",
  { id: id(), name: text(), seats: integer() },
  { traits: [archivable({ cascade: ["invoices"] }), timestamps()] },
);

const tasks = table(
  "tasks",
  {
    id: id(),
    ownerId: uuid().references("users"),
    orgId: uuid().references("orgs"),
    title: text(),
    due: timestamptz().nullable(),
    status: text(),
  },
  {
    traits: [archivable({ cascade: ["notes"] }), timestamps()],
    presets: { open: (q) => q.where({ status: "open" }) },
    relations: {
      owner: one("users", "ownerId"),
      notes: many("notes", "taskId"),
      tags: manyThrough("tags", { through: "task_tags" }),
    },
  },
);

const notes = table(
  "notes",
  { id: id(), taskId: uuid().references("tasks"), body: text() },
  { traits: [archivable()] },
);

const tags = table(
  "tags",
  { id: id(), label: text() },
  { tenancy: global("labels are shared by every tenant") },
);

const taskTags = table("task_tags", {
  taskId: uuid().references("tasks"),
  tagId: uuid().references("tags"),
});

const invoices = table(
  "invoices",
  {
    id: id(),
    orgId: uuid().references("orgs"),
    total: numeric(12, 2),
    paid: boolean(),
  },
  { traits: [archivable()], presets: { large: (q) => q.where({ total: gte("1000") }) } },
);

const events = table("events", {
  id: id(),
  at: timestamptz(),
  payload: jsonb(),
});

const files = table("files", {
  id: id(),
  ownerId: uuid().references("users"),
  bytes: integer(),
  name: text(),
});

const sessions = table("sessions", {
  id: id(),
  userId: uuid().references("users"),
  seen: timestamptz(),
});

/** Schema built when this module is imported. */
export const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [users, orgs, tasks, notes, tags, taskTags, invoices, events, files, sessions],
});

/** Keeps the contracts entry in the bundle. Tree-shaking drops the unused exports. */
export const startupError = OkmError;

/**
 * A scoped read with an include, a page, an aggregate, a transaction and a batch.
 * Not called at import.
 *
 * @param url - Postgres connection string
 * @param tenantId - Tenant the client is scoped to
 * @returns The calls
 */
export function work(url: string, tenantId: string) {
  const db = connect(url, { schema: app }).for({ tenantId });
  return [
    db.tasks.open().find({ include: { owner: true, notes: { limit: 5 } }, limit: 10 }),
    db.tasks.page({ orderBy: { title: "asc" }, limit: 20 }),
    db.tasks.aggregate({ groupBy: ["status"], count: true, limit: 10 }),
    db.users.insert({ email: " A@B.C ", name: "a", active: true }),
    db.tasks.archive({ where: { id: eq("x") } }),
    db.tx(async (t) => {
      await t.orgs.update({ where: { id: eq("x") }, set: { seats: 5 } });
      return await t.invoices.large().find({ limit: 10 });
    }),
    db.batch([
      db.orgs.insert({ name: "o", seats: 1 }),
      db.users.update({ where: { id: eq("x") }, set: { active: false } }),
    ]),
  ] as const;
}

/**
 * One read through `connect`. Not called at import, so startup does not open a pool.
 *
 * @param url - Postgres connection string
 * @returns The first matching user
 */
export function readUser(url: string) {
  const db = connect(url, { schema: app });
  return db.for({ tenantId: "t" }).users.find({ where: { email: eq("a@b.c") }, limit: 1 });
}
