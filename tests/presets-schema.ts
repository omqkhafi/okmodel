/**
 * Tasks with presets, in a plain schema and in a tenant schema.
 *
 * Both tables are archivable, so a preset is checked against the tenant
 * predicate and the active set at once. The `flagged` trait adds a column and
 * a preset to every table it is on.
 */

import {
  boolean,
  gte,
  id,
  inList,
  integer,
  or,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable, trait } from "../src/runtime/traits/index.js";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

/** One owner. */
export const ADA = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";

/** Another owner. */
export const GRACE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

/**
 * An id for the n-th row a test inserts.
 *
 * @param n - Row number, 0 to 255
 * @returns A uuid
 */
export function rowId(n: number): string {
  return `01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d${n.toString(16).padStart(2, "0")}`;
}

/** Adds a `flagged` column and a `flagged` preset to every table it is on. */
export const flagged = trait("flagged", {
  fields: { flagged: boolean().default(false) },
  presets: {
    flagged: (q) => q.where({ flagged: true }),
  },
});

const columns = {
  id: id({ default: "none" }),
  title: text(),
  status: text(),
  ownerId: uuid(),
  priority: integer(),
};

const tasks = table("tasks", columns, {
  traits: [archivable(), flagged],
  presets: {
    pending: (q) => q.where({ status: "pending" }),
    ownedBy: (q, owner: string) => q.where({ ownerId: owner }),
    urgent: (q) => q.where({ priority: gte(3) }),
    inState: (q, ...states: readonly string[]) => q.where({ status: inList(states) }),
    mineOrOpen: (q, owner: string) => q.where(or([{ ownerId: owner }, { status: "open" }])),
    stale: (q) => q.where({ status: "pending" }).where({ priority: gte(2) }),
  },
});

/** Plain schema: one archivable table with every preset kind. */
export const app = schema({ casing: "snake", tables: [tasks] });

const tenantTasks = table("tasks", columns, {
  traits: [archivable(), flagged],
  presets: {
    pending: (q) => q.where({ status: "pending" }),
    ownedBy: (q, owner: string) => q.where({ ownerId: owner }),
    urgent: (q) => q.where({ priority: gte(3) }),
    inState: (q, ...states: readonly string[]) => q.where({ status: inList(states) }),
    mineOrOpen: (q, owner: string) => q.where(or([{ ownerId: owner }, { status: "open" }])),
  },
});

/** Tenant schema: the same table with column tenancy. */
export const tenantApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tenantTasks],
});
