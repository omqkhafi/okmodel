/**
 * `version` and `position` are on the row, not on insert or update.
 *
 * `move` appears because this file imports `okmodel/traits`. On a versioned
 * table, `version` is required on `update` (Q5 / D305). A non-versioned table
 * keeps `version` optional in the type.
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

const plain = table("plain", {
  id: t.text().primaryKey(),
  title: t.text(),
});

const app = schema({ tables: [tasks, plain] });

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~row"]>().toEqualTypeOf<
  "id" | "title" | "laneId" | "version" | "position"
>();

expectTypeOf<(typeof app)["~byName"]["tasks"]>().toMatchTypeOf<{
  readonly "~versioned": true;
}>();

expectTypeOf<(typeof app)["~byName"]["plain"]>().not.toMatchTypeOf<{
  readonly "~versioned": true;
}>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~insert"]>().toEqualTypeOf<
  "id" | "title" | "laneId"
>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~update"]>().toEqualTypeOf<
  "title" | "laneId"
>();

type Api = TableApi<typeof app, "tasks">;
type PlainApi = TableApi<typeof app, "plain">;

expectTypeOf<Api["move"]>().toBeFunction();

declare const update: Api["update"];
declare const plainUpdate: PlainApi["update"];

void update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
void update([{ id: "1", set: { title: "b" }, version: 2 }]);

// @ts-expect-error versioned update needs the version read from the row
void update({ where: { id: "1" }, set: { title: "b" } });
// @ts-expect-error each list item needs version on a versioned table
void update([{ id: "1", set: { title: "b" } }]);

void plainUpdate({ where: { id: "1" }, set: { title: "b" } });
void plainUpdate([{ id: "1", set: { title: "b" } }]);
void plainUpdate({ where: { id: "1" }, set: { title: "b" }, version: 1 });
