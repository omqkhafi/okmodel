/**
 * The 0.2 gate schema (P30).
 *
 * Every feature of the train sits in one schema so the gate property tests can
 * compose them: column tenancy, `timestamps()`, `archivable()` with cascade to
 * direct children, `one`, `many` and `manyThrough`, presets (one from a trait),
 * hidden and guarded fields, and one global table. Both tenants use the same
 * small pool of ids and the same names, so a missing predicate shows as a
 * foreign row and not as a missing row.
 */

import {
  boolean,
  gte,
  id,
  integer,
  many,
  manyThrough,
  one,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { archivable, timestamps, trait } from "../src/runtime/traits/index.js";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

/** The tenants the gate tests run as. */
export const TENANTS = [TENANT_A, TENANT_B] as const;

/** A tenant key. */
export type Tenant = (typeof TENANTS)[number];

/** How many ids each table has. Both tenants draw from the same pool. */
export const POOL = 4;

/**
 * An id both tenants can use.
 *
 * @param kind - Table letter: `o` org, `p` project, `t` task, `l` label, `j` join row
 * @param n - Pool index, 0 to {@link POOL} minus 1 (or more, for bulk seeds)
 * @returns A uuid
 */
export function key(kind: "o" | "p" | "t" | "l" | "j" | "c", n: number): string {
  const code = { o: 1, p: 2, t: 3, l: 4, j: 5, c: 6 }[kind];
  return `01890c5a-8f0e-7c3a-9b2d-${code.toString(16).padStart(4, "0")}00${n
    .toString(16)
    .padStart(6, "0")}`;
}

/** Adds a `starred` column and a `starred` preset to every table it is on. */
export const starred = trait("starred", {
  fields: { starred: boolean().default(false) },
  presets: { starred: (q) => q.where({ starred: true }) },
});

const orgs = table(
  "orgs",
  {
    id: id({ default: "none" }),
    name: text().unique(),
    apiKey: text().hidden().default("org-secret"),
  },
  {
    traits: [archivable({ cascade: ["projects"] }), timestamps()],
    relations: { projects: many("projects", "orgId") },
  },
);

const projects = table(
  "projects",
  {
    id: id({ default: "none" }),
    orgId: uuid().references("orgs"),
    name: text().unique(),
    budget: integer().default(0),
    tier: text().guarded().default("free"),
    notes: text().hidden().default(""),
  },
  {
    traits: [archivable({ cascade: ["tasks"] }), timestamps(), starred],
    presets: {
      rich: (q) => q.where({ budget: gte(100) }),
      inOrg: (q, orgId: string) => q.where({ orgId }),
    },
    relations: {
      org: one("orgs", "orgId"),
      tasks: many("tasks", "projectId"),
      labels: manyThrough("labels", { through: "projectLabels" }),
    },
  },
);

const tasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    projectId: uuid().references("projects"),
    title: text().unique(),
    priority: integer().default(1),
    done: boolean().default(false),
  },
  {
    traits: [archivable(), timestamps(), starred],
    presets: {
      open: (q) => q.where({ done: false }),
      urgent: (q) => q.where({ priority: gte(3) }),
    },
    relations: { project: one("projects", "projectId") },
  },
);

const labels = table(
  "labels",
  { id: id({ default: "none" }), name: text() },
  {
    traits: [archivable()],
    relations: { projects: manyThrough("projects", { through: "projectLabels" }) },
  },
);

const projectLabels = table(
  "projectLabels",
  {
    id: id({ default: "none" }),
    projectId: uuid().references("projects"),
    labelId: uuid().references("labels"),
  },
  {
    traits: [archivable()],
    relations: { project: one("projects", "projectId"), label: one("labels", "labelId") },
  },
);

const countries = table(
  "countries",
  { id: id({ default: "none" }), name: text() },
  { tenancy: global("shared reference data") },
);

/** The schema under test. */
export const gateApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [orgs, projects, tasks, labels, projectLabels, countries],
});

/** Names of the tenant tables, parents first. */
export const TENANT_TABLES = ["orgs", "projects", "tasks", "labels", "projectLabels"] as const;

/** A tenant table of the gate schema. */
export type TenantTable = (typeof TENANT_TABLES)[number];
