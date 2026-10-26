/**
 * `version` and `position` are on the row, not on insert or update.
 *
 * `move` appears because this file imports `okmodel/traits`. On a versioned
 * table, `version` is required on `update` (Q5 / D305). `version: "any"`
 * compiles only with `lock: "skip"` and `limit`. A non-versioned table
 * refuses `version`. A union that includes a versioned table requires it.
 * `.all()` and an `onConflict` update are refused on a versioned table.
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
    secret: t.text().hidden(),
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
void plainUpdate({ where: { id: "1" }, set: { title: "b" } }).all("qa");
// @ts-expect-error version on a table that is not versioned()
void plainUpdate({ where: { id: "1" }, set: { title: "b" }, version: 1 });
// @ts-expect-error version on a table that is not versioned()
void plainUpdate([{ id: "1", set: { title: "b" }, version: 1 }]);
void plainUpdate({
  where: { id: "1" },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  // @ts-expect-error version: "any" is only on a versioned table
  version: "any",
});

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
void claimHidden({
  where: {
    // @ts-expect-error a plain hidden column is not a where key, including version: "any"
    secret: "x",
  },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: "any",
});
declare const mixedVersion: "any" | number;
// @ts-expect-error "any" | number matches neither version form
void update({
  where: { id: "1" },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: mixedVersion,
});
// @ts-expect-error "any" | number is not the integer read from the row
void update({ where: { id: "1" }, set: { title: "b" }, version: mixedVersion });
const claimedId = update(
  {
    where: { id: "1" },
    set: { title: "b" },
    limit: 1,
    lock: "skip",
    version: "any",
  },
  { returning: ["id"] },
);
expectTypeOf(claimedId).resolves.toEqualTypeOf<readonly { readonly id: string }[]>();
const versionedUpdate = update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
// @ts-expect-error versioned update cannot use all()
void versionedUpdate.all("qa");
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

declare const insert: Api["insert"];
void insert({ id: "1", title: "a", laneId: "l" }, { onConflict: "ignore" });
void insert({ id: "1", title: "a", laneId: "l" }, { onConflict: { on: "id", return: true } });
// @ts-expect-error onConflict update does not check the version you read
void insert({ id: "1", title: "a", laneId: "l" }, { onConflict: { on: "id", update: ["title"] } });

declare const either: "tasks" | "plain";
const eitherHandle = db.table(either);
// @ts-expect-error a union that includes a versioned table needs version
void eitherHandle.update({ where: { id: "1" }, set: { title: "b" } });
void eitherHandle.update({ where: { id: "1" }, set: { title: "b" }, version: 1 });
declare const plainInsert: PlainApi["insert"];
void plainInsert({ id: "1", title: "a" }, { onConflict: { on: "id", update: ["title"] } });
