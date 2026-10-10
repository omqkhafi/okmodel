/**
 * Composite and path schemas for the tenancy strategy tests.
 *
 * Composite keys are a list, in declaration order. Path tables name a relation
 * chain that ends at a table carrying those keys.
 */

import { id, index, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { columnTenancy, compositeTenancy, via } from "../src/runtime/tenancy/index.js";

/** First organization. */
export const ORG_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";

/** Second organization. */
export const ORG_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";

/** First workspace. */
export const WS_1 = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";

/** Second workspace. */
export const WS_2 = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

/** Document id shared by every key combination. */
export const DOC = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c31";

/** File id shared by every key combination. */
export const FILE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c32";

/** Single-key tenant used by the path schema. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

/** The other tenant. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

/** Organization id shared by both path tenants. */
export const ORG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";

/** Project id under that organization. */
export const PROJECT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";

/** Department id for the three-hop path. */
export const DEPT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03";

/** Team id for the three-hop path. */
export const TEAM = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c04";

/** Note id at the end of the three-hop path. */
export const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c05";

const compositeKeys = compositeTenancy({
  key: ["organizationId", "workspaceId"],
  type: "uuid",
});

const documents = table(
  "documents",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    body: text(),
  },
  { indexes: (columns) => [index(...tenantHandles(columns, "organizationId", "workspaceId"))] },
);

const files = table(
  "files",
  { id: id({ default: "none" }), name: text() },
  {
    traits: [archivable()],
    indexes: (columns) => [index(...tenantHandles(columns, "organizationId"))],
  },
);

/** Composite tenancy: organization and workspace together. */
export const compositeApp = schema({
  casing: "snake",
  tenancy: compositeKeys,
  tables: [documents, files],
});

const organizations = table(
  "organizations",
  { id: id({ default: "none" }), name: text() },
  { indexes: (columns) => [index(...tenantHandles(columns, "tenantId"))] },
);

const projects = table(
  "projects",
  {
    id: id({ default: "none" }),
    name: text(),
    organizationId: uuid().references("organizations"),
  },
  {
    tenancy: via("organization"),
    relations: { organization: one("organizations", "organizationId") },
  },
);

const departments = table(
  "departments",
  {
    id: id({ default: "none" }),
    name: text(),
    organizationId: uuid().references("organizations"),
  },
  {
    tenancy: via("organization"),
    relations: { organization: one("organizations", "organizationId") },
  },
);

const teams = table(
  "teams",
  {
    id: id({ default: "none" }),
    name: text(),
    departmentId: uuid().references("departments"),
  },
  {
    tenancy: via("department.organization"),
    relations: { department: one("departments", "departmentId") },
  },
);

const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    body: text(),
    teamId: uuid().references("teams"),
  },
  {
    tenancy: via("team.department.organization"),
    relations: { team: one("teams", "teamId") },
  },
);

/** Path tenancy: one hop on projects, three hops on notes. */
export const pathApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [organizations, projects, departments, teams, notes],
});

function tenantHandles(columns: object, ...fields: readonly string[]): { readonly name: string }[] {
  const record = columns as Readonly<Record<string, { readonly name: string }>>;
  return fields.map((field) => {
    const handle = record[field];
    if (handle === undefined) {
      throw new Error(`Index handle ${field} is missing.`);
    }
    return handle;
  });
}
