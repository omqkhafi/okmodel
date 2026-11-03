import { schema, table, t } from "okmodel/pg";

/** Notes with a due day and a created time, read as ISO strings. */
export const notes = table("example_notes", {
  id: t.identity(),
  title: t.text(),
  dueOn: t.date().nullable(),
  createdAt: t.timestamptz().defaultSql("now()"),
});

export const app = schema({ casing: "snake", tables: [notes] });
