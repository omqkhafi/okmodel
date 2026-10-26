/**
 * `version` and `position` are on the row, not on insert or update.
 *
 * `move` appears because this file imports `okmodel/traits`. On a versioned
 * table, `version` is required on `update` (Q5 / D305). `version: "any"`
 * compiles only with `lock: "skip"` and `limit`. A non-versioned table
 * keeps `version` optional in the type.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected, TableApi } from "../src/runtime/types.js";
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

const queued = table(
  "queued",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    state: t.text().hidden({ filterable: true }),
  },
  { traits: [versioned()] },
);

const app = schema({ tables: [tasks, plain, queued] });

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

const claimed = update({
  where: { id: "1" },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: "any",
});
expectTypeOf(claimed).resolves.toEqualTypeOf<
  readonly {
    readonly id: string;
    readonly title: string;
    readonly laneId: string;
    readonly version: number;
    readonly position: number;
  }[]
>();

expectTypeOf(
  update({ where: { id: "1" }, set: { title: "b" }, version: 1 }),
).resolves.toEqualTypeOf<{ readonly count: number }>();

// @ts-expect-error versioned update needs the version read from the row
void update({ where: { id: "1" }, set: { title: "b" } });
// @ts-expect-error each list item needs version on a versioned table
void update([{ id: "1", set: { title: "b" } }]);
// @ts-expect-error version: "any" needs lock: "skip" and limit
void update({ where: { id: "1" }, set: { title: "b" }, version: "any" });
// @ts-expect-error version: "any" needs limit
void update({ where: { id: "1" }, set: { title: "b" }, lock: "skip", version: "any" });
// @ts-expect-error version: "any" needs lock: "skip"
void update({ where: { id: "1" }, set: { title: "b" }, limit: 1, version: "any" });

void plainUpdate({ where: { id: "1" }, set: { title: "b" } });
void plainUpdate([{ id: "1", set: { title: "b" } }]);
void plainUpdate({ where: { id: "1" }, set: { title: "b" }, version: 1 });
const bare = plainUpdate;
// @ts-expect-error version: "any" is only on a versioned table
void bare({ where: { id: "1" }, set: { title: "b" }, limit: 1, lock: "skip", version: "any" });

declare const claimHidden: TableApi<typeof app, "queued">["update"];
void claimHidden({
  where: { state: "pending" },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: "any",
});
void update({
  // @ts-expect-error an unknown where field rejects the call, including version: "any"
  where: { id: "1", nope: true },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: "any",
});
type UpdateParam = Parameters<Api["update"]>[0];
const validParam: UpdateParam = { where: { id: "1" }, set: { title: "b" }, version: 1 };
void validParam;
// @ts-expect-error versioned update needs the version read from the row
const missingParam: UpdateParam = { where: { id: "1" }, set: { title: "b" } };
void missingParam;
const extraParam: UpdateParam = {
  where: { id: "1" },
  set: { title: "b" },
  version: 1,
  // @ts-expect-error unknown key
  nope: true,
};
void extraParam;
// @ts-expect-error Parameters reads the integer update, so version: "any" is not a member
const anyParam: UpdateParam = { where: { id: "1" }, set: { title: "b" }, version: "any" };
void anyParam;

declare const db: Connected<typeof app>;
declare const both: "tasks" | "queued";
const bothHandle = db.table(both);
// @ts-expect-error a union of versioned tables needs version
void bothHandle.update({ where: { id: "1" }, set: { title: "b" } });
void bothHandle.update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
