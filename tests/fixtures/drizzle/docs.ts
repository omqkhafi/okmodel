/**
 * Table shapes from the Drizzle docs: users, posts with a foreign key, an
 * enum, a composite primary key, a generated column, and a partial index.
 *
 * Names are the ones those pages store. `relations()` is not a table.
 */

import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const mood = pgEnum("mood", ["sad", "ok", "happy"]);

export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
});

export const posts = pgTable(
  "posts",
  {
    id: integer("id").primaryKey(),
    content: text("content"),
    authorId: integer("author_id").notNull().references(() => users.id),
    mood: mood("mood").notNull(),
    total: integer("total").generatedAlwaysAs(sql`1`),
  },
  (table) => [
    index("posts_content_idx").on(table.content).where(sql`${table.content} is not null`),
  ],
);

export const booksToAuthors = pgTable(
  "books_to_authors",
  {
    authorId: integer("author_id").notNull(),
    bookId: integer("book_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bookId, table.authorId] })],
);
