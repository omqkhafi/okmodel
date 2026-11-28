/**
 * pgvector query types.
 *
 * `within` is a where value. `nearest` is an orderBy value. `page` refuses it.
 * `select` stays a list: `distance` is named with `.as()`.
 */

import { pgvector } from "../src/dialects/pg/ext/pgvector.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const vec = pgvector();
const docs = table(
  "docs",
  { id: t.id(), body: t.text(), embedding: vec.vector(3) },
  {
    indexes: (column) => [
      vec.hnsw(column.embedding, { metric: "cosine", m: 16, efConstruction: 64 }),
    ],
  },
);
const app = schema({ tables: [docs], extensions: [vec] });
const db = connect("postgres://okm:okm@127.0.0.1/okm", { schema: app });
const q = [1, 0, 0] as const;

await db.docs.find({
  select: ["id", vec.distance("embedding", q, "cosine").as("distance")],
  where: { embedding: vec.within(q, { metric: "cosine", max: 0.35 }) },
  orderBy: { embedding: vec.nearest(q, "cosine") },
  limit: 10,
});

// @ts-expect-error page refuses nearest(); the cursor cannot encode a distance
await db.docs.page({ orderBy: { embedding: vec.nearest(q, "cosine") }, limit: 10 });

// @ts-expect-error a vector column does not take a text pattern
await db.docs.find({ where: { embedding: { startsWith: "a" } } });
