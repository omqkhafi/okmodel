/**
 * Schema traits and table traits show up on the row, and not on the write.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, t } from "../src/dialects/pg/index.js";
import { timestamps } from "../src/runtime/traits/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});

const external = table(
  "external",
  { id: t.text().primaryKey(), name: t.text() },
  { omitDefaults: "owned outside okmodel" },
);

const app = schema({
  casing: "snake",
  traits: [timestamps()],
  tables: [notes, external],
});

expectTypeOf<keyof (typeof app)["~byName"]["notes"]["~row"]>().toEqualTypeOf<
  "id" | "title" | "createdAt" | "updatedAt"
>();

expectTypeOf<keyof (typeof app)["~byName"]["notes"]["~insert"]>().toEqualTypeOf<"id" | "title">();

expectTypeOf<keyof (typeof app)["~byName"]["notes"]["~update"]>().toEqualTypeOf<"title">();

expectTypeOf<keyof (typeof app)["~byName"]["external"]["~row"]>().toEqualTypeOf<"id" | "name">();

const local = table("local", { title: t.text() }, { traits: [timestamps()] });

expectTypeOf<keyof (typeof local)["~row"]>().toEqualTypeOf<"title" | "createdAt" | "updatedAt">();

expectTypeOf<keyof (typeof local)["~insert"]>().toEqualTypeOf<"title">();
