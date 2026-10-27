/**
 * N-50: `Parameters` of one table's `update` accepts a version.
 *
 * A generic helper that calls `update` with a literal table key is TS2769.
 * A helper typed against the union handle with `version` is TS2349.
 * An overload that accepted those calls would break `version: "any"`.
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
const pages = table(
  "pages",
  { id: t.text().primaryKey(), title: t.text() },
  { traits: [versioned()] },
);
const app = schema({ tables: [docs, notes, pages] });
declare const db: Connected<typeof app>;

type DocUpdate = Parameters<typeof db.docs.update>[0];

function saveDoc(target: DocUpdate): ReturnType<typeof db.docs.update> {
  return db.docs.update(target);
}

saveDoc({ where: { id: "1" }, set: { title: "b" }, version: 1 });

function saveTable<K extends keyof (typeof app)["~byName"]>(
  name: K,
  target: Parameters<TableApi<typeof app, K>["update"]>[0],
) {
  return db.table(name).update(target);
}

saveTable("docs", { where: { id: "1" }, set: { title: "b" }, version: 1 });
saveTable("notes", { where: { id: "1" }, set: { body: "n" }, version: 2 });

function saveDocs<K extends "docs">(name: K) {
  // @ts-expect-error generic K: a literal table key matches no update overload (N-50, TS2769)
  return db.table(name).update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
}
saveDocs("docs");

type UnionHandle = typeof db.docs | typeof db.pages;

function saveEither(handle: UnionHandle) {
  // @ts-expect-error union handle with version is not callable (N-50, TS2349)
  return handle.update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
}
void saveEither;
