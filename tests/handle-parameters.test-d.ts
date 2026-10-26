/**
 * N-50: a helper built from the handle's `update` accepts a version.
 *
 * V34 aliases `Parameters<typeof db.docs.update>[0]`. G3 and G4 are generic
 * over the table name and take the target from `Parameters`.
 */

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected, TableApi } from "../src/runtime/types.js";
import { versioned } from "../src/runtime/traits/index.js";

const docs = table(
  "docs",
  { id: t.text().primaryKey(), title: t.text() },
  { traits: [versioned()] },
);
const notes = table(
  "notes",
  { id: t.text().primaryKey(), body: t.text() },
  { traits: [versioned()] },
);
const app = schema({ tables: [docs, notes] });
declare const db: Connected<typeof app>;

type DocUpdate = Parameters<typeof db.docs.update>[0];

function saveDoc(target: DocUpdate): ReturnType<typeof db.docs.update> {
  return db.docs.update(target);
}

saveDoc({ where: { id: "1" }, set: { title: "b" }, version: 1 });

function saveTable<K extends keyof (typeof app)["~byName"] & string>(
  name: K,
  target: Parameters<TableApi<typeof app, K>["update"]>[0],
) {
  return db.table(name).update(target);
}

saveTable("docs", { where: { id: "1" }, set: { title: "b" }, version: 1 });
saveTable("notes", { where: { id: "1" }, set: { body: "n" }, version: 2 });
