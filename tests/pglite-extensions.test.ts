/**
 * `testing()` loads the contrib bundles a PGlite schema declares.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { testing } from "../src/tooling/testing/index.js";

test("testing() loads pg_trgm before applying the catalog", async () => {
  const trgm = pgTrgm();
  const app = schema({
    tables: [
      table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] }),
    ],
    extensions: [trgm],
  });
  const harness = await testing(app, { driver: open() });
  try {
    const row = await harness.db.docs.insert({ body: "okmodel search" });
    expect(row.body).toBe("okmodel search");
    expect(await harness.db.docs.find({ limit: 1 })).toEqual([row]);
  } finally {
    await harness.close();
  }
});
