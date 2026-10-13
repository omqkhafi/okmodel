/**
 * A self-related tree, a nullable foreign key, and a join table.
 *
 * `nodes` has two parents so a walk must name which one. `items.ownerId` cannot
 * be cleared. `badLinks.note` has no default, so `sync` cannot insert that row.
 */

import { id, many, manyThrough, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c00a1";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c00b2";

const nodes = table(
  "nodes",
  {
    id: id({ default: "none" }),
    parentId: uuid().nullable().references("nodes"),
    managerId: uuid().nullable().references("nodes"),
    name: text(),
  },
  {
    traits: [archivable()],
    relations: {
      parent: one("nodes", "parentId"),
      children: many("nodes", "parentId"),
      manager: one("nodes", "managerId"),
      reports: many("nodes", "managerId"),
      tags: manyThrough("tags", { through: "nodeTags" }),
    },
    presets: {
      called: (q, name: string) => q.where({ name }),
    },
  },
);

const tags = table(
  "tags",
  { id: id({ default: "none" }), name: text() },
  {
    relations: {
      nodes: manyThrough("nodes", { through: "nodeTags" }),
      noted: manyThrough("nodes", { through: "badLinks" }),
    },
    presets: {
      named: (q, name: string) => q.where({ name }),
    },
  },
);

const nodeTags = table(
  "nodeTags",
  {
    nodeId: uuid().references("nodes"),
    tagId: uuid().references("tags"),
  },
  { primaryKey: ["nodeId", "tagId"] },
);

const badLinks = table(
  "badLinks",
  {
    nodeId: uuid().references("nodes"),
    tagId: uuid().references("tags"),
    note: text(),
  },
  { primaryKey: ["nodeId", "tagId"] },
);

const folders = table(
  "folders",
  { id: id({ default: "none" }), name: text() },
  {
    relations: {
      files: many("files", "folderId"),
      items: many("items", "ownerId"),
    },
  },
);

const files = table(
  "files",
  {
    id: id({ default: "none" }),
    folderId: uuid().nullable().references("folders"),
    name: text(),
  },
  { relations: { folder: one("folders", "folderId") } },
);

const items = table(
  "items",
  {
    id: id({ default: "none" }),
    ownerId: uuid().references("folders"),
    name: text(),
  },
  { relations: { owner: one("folders", "ownerId") } },
);

/** Schema under test. */
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [nodes, tags, nodeTags, badLinks, folders, files, items],
});
