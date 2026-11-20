import { schema, table, t } from "../src/dialects/pg/index.js";

const notes = table("notes", { id: t.identity(), name: t.text() });

schema({ minPostgres: 15, tables: [notes] });
schema({ minPostgres: 18, tables: [notes] });
schema({ minPostgres: 19, tables: [notes] });
schema({ minPostgres: 20, tables: [notes] });
schema({ minPostgres: 25, tables: [notes] });

// @ts-expect-error minPostgres is an integer major, not a string
schema({ minPostgres: "17", tables: [notes] });
