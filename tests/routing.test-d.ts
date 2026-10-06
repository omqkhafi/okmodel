/**
 * `using` exists on a topology client only.
 *
 * A string or pool client has no such member. A derived client has no `close`
 * and no `using`.
 */

import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";

const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

type Has<T, K extends string> = K extends keyof T ? true : false;

void (async () => {
  const plain = await connect("memory://plain", { schema: app });
  expectTypeOf<Has<typeof plain, "using">>().toEqualTypeOf<false>();
  void plain.notes.find({ limit: 1, route: "primary" });
  void plain.notes.find({ limit: 1, route: "replica" });

  const routed = await connect(
    { primary: "memory://primary", replicas: ["memory://east"] },
    { schema: app },
  );
  expectTypeOf<Has<typeof routed, "using">>().toEqualTypeOf<true>();
  const scoped = routed.using("replica");
  expectTypeOf<Has<typeof scoped, "close">>().toEqualTypeOf<false>();
  expectTypeOf<Has<typeof scoped, "using">>().toEqualTypeOf<false>();
  expectTypeOf<Has<typeof scoped, "notes">>().toEqualTypeOf<true>();
});
