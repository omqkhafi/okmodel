import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import {
  buildCatalog,
  describe,
  type LogicalIdentity,
  type SchemaDescription,
} from "../src/tooling/migrate/index.js";

const app = schema({
  tables: [
    table("users", {
      id: t.uuid().primaryKey(),
      email: t.text(),
    }),
  ],
});

const description = describe(app);

expectTypeOf(description).toEqualTypeOf<SchemaDescription>();
expectTypeOf(description.logical).toEqualTypeOf<LogicalIdentity>();
expectTypeOf(buildCatalog(description)).toEqualTypeOf(app.catalog);
