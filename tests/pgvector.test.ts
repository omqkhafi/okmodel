/**
 * pgvector declarations, without a server.
 *
 * Dimension checks, the operator class, and storage text are decided before SQL.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { pgvector } from "../src/dialects/pg/ext/pgvector.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { featuresUsed } from "../src/tooling/capabilities/used.js";
import {
  EXTENSION_NOT_TRUSTED,
  extensionCreateDenied,
  refuseHnswMemory,
} from "../src/tooling/migrate/extensions.js";

const vec = pgvector();

function indexesOf(app: { readonly catalog: { readonly objects: readonly object[] } }): string[] {
  const found: string[] = [];
  for (const object of app.catalog.objects) {
    if (!("kind" in object) || object.kind !== "index") continue;
    if (
      !("definition" in object) ||
      typeof object.definition !== "object" ||
      object.definition === null
    ) {
      continue;
    }
    if (!("expression" in object.definition) || typeof object.definition.expression !== "string")
      continue;
    found.push(object.definition.expression);
  }
  return found;
}

test("vector and halfvec refuse an empty, non-finite, or wrong-length value before SQL", () => {
  const column = vec.vector(3);
  expect(column.encode([1, 2, 3])).toBe("[1,2,3]");
  expect(column.decode("[1,2,3]")).toEqual([1, 2, 3]);
  expect(vec.halfvec(2).encode([0.5, -0])).toBe("[0.5,0]");
  expect(column.decode("[1, 2, 3]")).toEqual([1, 2, 3]);
  for (const value of [
    [],
    [1, 2],
    [1, Number.NaN, 3],
    [1, Number.POSITIVE_INFINITY, 3],
    [1, "2", 3],
  ]) {
    expect(() => column.encode(value as number[])).toThrow(OkmError);
  }
  try {
    column.encode([]);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1210");
  }
});

test("vector(n) above 16000 is OKM1930, and so is halfvec", () => {
  expect(() => vec.vector(16001)).toThrow(/vector\(16001\) is above 16000/);
  expect(() => vec.halfvec(16001)).toThrow(/halfvec\(16001\) is above 16000/);
  expect(() => vec.vector(0)).toThrow(/needs a dimension from 1 to 16000/);
  try {
    vec.vector(16001);
  } catch (error) {
    expect((error as OkmError).code).toBe("OKM1930");
  }
});

test("hnsw storage is WITH text, and a string name follows the column type", () => {
  const docs = table(
    "docs",
    { id: t.id(), embedding: vec.halfvec(4) },
    {
      indexes: () => [vec.hnsw("embedding", { metric: "cosine", m: 16, efConstruction: 64 })],
    },
  );
  const app = schema({ tables: [docs], extensions: [vec] });
  expect(indexesOf(app)).toEqual(['using hnsw ("embedding" halfvec_cosine_ops)']);
  const sql = renderCatalog(app.catalog, "public").join("\n");
  expect(sql).toContain(
    'using hnsw ("embedding" halfvec_cosine_ops) with (ef_construction=64, m=16)',
  );
  expect(featuresUsed(app.catalog)).toEqual(
    expect.arrayContaining(["ext.pgvector", "type.halfvec", "index.hnsw", "index.expression"]),
  );
});

test("a column handle selects vector_cosine_ops", () => {
  const docs = table(
    "docs",
    { id: t.id(), embedding: vec.vector(8) },
    {
      indexes: (column) => [vec.hnsw(column.embedding, { metric: "l2" })],
    },
  );
  const app = schema({ tables: [docs], extensions: [vec] });
  expect(indexesOf(app)).toEqual(['using hnsw ("embedding" vector_l2_ops)']);
});

test("hnsw above 2000 on vector, and above 4000 on halfvec, is OKM1930", () => {
  const wide = table(
    "docs",
    { id: t.id(), embedding: vec.vector(2001) },
    { indexes: () => [vec.hnsw("embedding", { metric: "cosine" })] },
  );
  expect(() => schema({ tables: [wide], extensions: [vec] }).catalog).toThrow(
    /hnsw on docs.embedding is above 2000 dimensions for vector/,
  );
  const half = table(
    "docs",
    { id: t.id(), embedding: vec.halfvec(4001) },
    { indexes: () => [vec.hnsw("embedding", { metric: "ip" })] },
  );
  expect(() => schema({ tables: [half], extensions: [vec] }).catalog).toThrow(
    /hnsw on docs.embedding is above 4000 dimensions for halfvec/,
  );
});

test("ivfflat above 2000 is OKM1930", () => {
  const wide = table(
    "docs",
    { id: t.id(), embedding: vec.vector(2001) },
    { indexes: () => [vec.ivfflat("embedding", { metric: "l2", lists: 10 })] },
  );
  expect(() => schema({ tables: [wide], extensions: [vec] }).catalog).toThrow(
    /ivfflat on docs.embedding is above 2000 dimensions/,
  );
});

test("two indexes on the same column and metric are OKM1930", () => {
  const docs = table(
    "docs",
    { id: t.id(), embedding: vec.vector(3) },
    {
      indexes: () => [
        vec.hnsw("embedding", { metric: "cosine" }),
        vec.ivfflat("embedding", { metric: "cosine", lists: 8 }),
      ],
    },
  );
  expect(() => schema({ tables: [docs], extensions: [vec] }).catalog).toThrow(
    /docs.embedding already has a cosine index/,
  );
});

test("a missing metric is OKM1930", () => {
  expect(() => vec.hnsw("embedding", { metric: undefined as unknown as "cosine" })).toThrow(
    /hnsw on embedding needs a metric/,
  );
});

test("CREATE EXTENSION 42501 uses the not-trusted sentence, and hnsw 53100 is OKM2208", () => {
  expect(extensionCreateDenied("42501", "create extension vector")).toBe(EXTENSION_NOT_TRUSTED);
  expect(extensionCreateDenied("42501", "create table docs ()")).toBeUndefined();
  expect(() =>
    refuseHnswMemory(
      "53100",
      'create index "docs_embedding_idx" using hnsw ("embedding" vector_cosine_ops)',
    ),
  ).toThrow(/shared memory/);
  try {
    refuseHnswMemory(
      "53100",
      'create index "docs_embedding_idx" using hnsw ("embedding" vector_cosine_ops)',
    );
  } catch (error) {
    expect((error as OkmError).code).toBe("OKM2208");
  }
  expect(() =>
    refuseHnswMemory("53100", 'create index "docs_id_idx" using btree ("id")'),
  ).not.toThrow();
});
