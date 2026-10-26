/**
 * The Drizzle docs shapes as okmodel tables.
 *
 * Users, posts with a foreign key, an enum, a composite primary key, a
 * generated column, and a partial index. `okm import drizzle` of
 * `tests/fixtures/drizzle/docs.ts` compiles to this catalog.
 */

import { index, schema, t, table } from "../../../src/dialects/pg/index.js";

export const users = table(
  "users",
  {
    id: t.integer(),
    name: t.text().nullable(),
    email: t.text().unique(),
  },
  { primaryKey: ["id"] },
);

export const posts = table(
  "posts",
  {
    id: t.integer(),
    content: t.text().nullable(),
    author_id: t.integer().references("users", { columns: ["id"] }),
    mood: t.enum("mood", ["sad", "ok", "happy"]),
    total: t.integer().nullable().generated("1"),
  },
  {
    primaryKey: ["id"],
    indexes: (columns) => [{ ...index(columns.content), predicate: '"content" is not null' }],
  },
);

export const booksToAuthors = table(
  "books_to_authors",
  {
    author_id: t.integer(),
    book_id: t.integer(),
  },
  { primaryKey: ["book_id", "author_id"] },
);

/** Catalog the Drizzle docs fixture must match. */
export const docs = schema({ tables: [users, posts, booksToAuthors] });
