import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.uuid(),
  title: t.text(),
});

export const app = schema({ tables: [notes] });
