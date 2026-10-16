import { expectTypeOf } from "expect-type";

import { external, schema, t, table } from "../src/dialects/pg/index.js";

const users = table("users", {
  id: t.uuid().primaryKey(),
  email: t.text(),
});

const marked = external(users);

expectTypeOf(marked).toEqualTypeOf(users);

const billing = schema({
  tables: [
    marked,
    table("invoices", {
      id: t.uuid().primaryKey(),
      userId: t.uuid().references("users"),
    }),
  ],
});

expectTypeOf(billing).toHaveProperty("catalog");
