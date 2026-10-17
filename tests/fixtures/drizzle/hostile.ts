/**
 * Hostile Drizzle fixture: composite primary key without column notNull, and a
 * Windows-reserved table name.
 */

import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const Con = pgTable(
  "con",
  {
    org: text("org"),
    num: integer("num"),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.org, table.num] })],
);
