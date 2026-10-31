import { schema, table, t } from "okmodel/pg";

export const notes = table("example_notes", {
  id: t.identity(),
  title: t.text(),
});

export const app = schema({ tables: [notes] });
