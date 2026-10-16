import { id, schema, table, text } from "../../src/dialects/pg/index.ts";

export const app = schema({
  tables: [table("notes", { id: id({ default: "none" }), title: text() })],
});
