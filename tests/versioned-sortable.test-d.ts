/**
 * `version` and `position` are on the row, not on insert or update.
 *
 * `move` appears because this file imports `okmodel/traits`. `version` on an
 * update is optional in the type; a versioned table requires it at runtime.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { TableApi } from "../src/runtime/types.js";
import { sortable, versioned } from "../src/runtime/traits/index.js";

const tasks = table(
  "tasks",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    laneId: t.text(),
  },
  { traits: [versioned(), sortable("laneId")] },
);

const app = schema({ tables: [tasks] });

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~row"]>().toEqualTypeOf<
  "id" | "title" | "laneId" | "version" | "position"
>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~insert"]>().toEqualTypeOf<
  "id" | "title" | "laneId"
>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~update"]>().toEqualTypeOf<
  "title" | "laneId"
>();

type Api = TableApi<typeof app, "tasks">;

expectTypeOf<Api["move"]>().toBeFunction();

declare const update: Api["update"];
void update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
void update([{ id: "1", set: { title: "b" }, version: 2 }]);
