/**
 * N-153: `version: "any"` with `{ allow }` may set a guarded column.
 *
 * `position` from `sortable()` is guarded. The claim still needs
 * `lock: "skip"` and `limit`. A key that is not in `allow` stays an error.
 */

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";
import { sortable, versioned } from "../src/runtime/traits/index.js";

const docs = table(
  "docs",
  { id: t.text().primaryKey(), title: t.text(), laneId: t.text() },
  { traits: [versioned(), sortable("laneId")] },
);
const app = schema({ tables: [docs] });
declare const db: Connected<typeof app>;

db.docs.update(
  {
    where: { id: "1" },
    set: { title: "b", position: 1 },
    limit: 1,
    lock: "skip",
    version: "any",
  },
  { allow: ["position"] },
);

db.docs.update(
  { where: { id: "1" }, set: { title: "b", position: 2 }, version: 4 },
  { allow: ["position"] },
);

db.docs.update(
  {
    where: { id: "1" },
    set: {
      title: "b",
      // @ts-expect-error position is guarded unless allow names it
      position: 1,
    },
    limit: 1,
    lock: "skip",
    version: "any",
  },
);

db.docs.update(
  {
    where: { id: "1" },
    set: {
      title: "b",
      // @ts-expect-error a typo is not the guarded column allow names
      positon: 1,
    },
    limit: 1,
    lock: "skip",
    version: "any",
  },
  { allow: ["position"] },
);
