/**
 * Fixture Drizzle schema for `okm import drizzle`.
 *
 * Test-only. The command imports this file with the project's drizzle-orm.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  serial,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const shop = pgSchema("shop");

export const noteStatus = shop.enum("note_status", ["open", "closed"]);

export const authors = shop.table("authors", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
});

export const notes = shop.table(
  "notes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    n: serial("n"),
    title: text("title").notNull().default("untitled"),
    open: boolean("open").notNull().default(true),
    status: noteStatus("status").notNull(),
    total: integer("total").generatedAlwaysAs(sql`1`),
    authorId: uuid("author_id").notNull().references(() => authors.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 40 }),
  },
  (table) => [
    index("notes_title_idx").on(table.title),
    uniqueIndex("notes_open_title").on(table.open).where(sql`${table.open} = true`),
    check("title_len", sql`length(${table.title}) > 0`),
  ],
);

export const pairs = shop.table(
  "pairs",
  {
    org: text("org").notNull(),
    num: integer("num").notNull(),
    authorId: uuid("author_id").notNull(),
    authorEmail: text("author_email").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.num] }),
    foreignKey({
      columns: [table.authorId, table.authorEmail],
      foreignColumns: [authors.id, authors.email],
    }).onDelete("cascade"),
  ],
);

const mood = customType<{ data: string }>({
  dataType() {
    return "mood";
  },
});

export const extras = shop.table("extras", {
  id: serial("id").primaryKey(),
  mood: mood("mood"),
});

export const authorsRelations = relations(authors, ({ many }) => ({
  notes: many(notes),
}));

export const extraSeq = shop.sequence("extra_seq");
