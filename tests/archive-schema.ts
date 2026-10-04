/**
 * Archivable lists, tasks, and reminders, plus a tenant pair.
 *
 * Cascade is direct: a list archives its tasks, a task archives its reminders.
 * Notes are not archivable. Tenant uniques are declared before the trait runs.
 */

import { id, many, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

/** A list both tenants can share as an id. */
export const LIST = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";

/** A task id. */
export const TASK = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";

/** A second task, used for the unique conflict. */
export const TASK_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c13";

/** A reminder id. */
export const REMINDER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c14";

/** A user id. Archiving the user leaves the task active. */
export const USER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c15";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

const users = table(
  "users",
  { id: id({ default: "none" }), name: text() },
  { traits: [archivable()] },
);

const lists = table(
  "lists",
  { id: id({ default: "none" }), name: text().unique() },
  {
    traits: [archivable({ cascade: ["tasks"] })],
    relations: { tasks: many("tasks", "listId") },
  },
);

const tasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    listId: uuid().references("lists"),
    ownerId: uuid().references("users"),
  },
  {
    traits: [archivable({ cascade: ["reminders"] })],
    relations: {
      list: one("lists", "listId"),
      owner: one("users", "ownerId"),
      reminders: many("reminders", "taskId"),
    },
  },
);

const reminders = table(
  "reminders",
  {
    id: id({ default: "none" }),
    taskId: uuid().references("tasks"),
    note: text(),
  },
  {
    traits: [archivable()],
    relations: { task: one("tasks", "taskId") },
  },
);

const notes = table("notes", {
  id: id({ default: "none" }),
  body: text().unique(),
});

/** Schema under test. Notes stay outside the trait. */
export const app = schema({
  casing: "snake",
  tables: [users, lists, tasks, reminders, notes],
});

const orgs = table(
  "orgs",
  { id: id({ default: "none" }), name: text().unique() },
  {
    traits: [archivable({ cascade: ["tasks"] })],
    relations: { tasks: many("tasks", "orgId") },
  },
);

const tenantTasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    orgId: uuid().references("orgs"),
  },
  {
    traits: [archivable()],
    relations: { org: one("orgs", "orgId") },
  },
);

/**
 * Tenant tables with `archivable()` on the table.
 *
 * The tenancy rewrite widens uniques first. The trait then makes those
 * uniques partial, so the tenant key stays on the index.
 */
export const tenantApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [orgs, tenantTasks],
});
