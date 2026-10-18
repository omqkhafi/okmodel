import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import {
  buildCatalog,
  describe,
  type LogicalIdentity,
  type RequiredExtension,
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
expectTypeOf(description.minPostgres).toEqualTypeOf<15 | 16 | 17 | 18>();
expectTypeOf(description.extensions).toEqualTypeOf<readonly RequiredExtension[]>();
expectTypeOf(buildCatalog(description)).toEqualTypeOf(app.catalog);
