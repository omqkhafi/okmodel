import { schema, table, t } from "../src/dialects/pg/index.js";

const notes = table("notes", { id: t.identity(), name: t.text() });

schema({ minPostgres: 15, tables: [notes] });
schema({ minPostgres: 18, tables: [notes] });

// @ts-expect-error 14 is below the supported majors
schema({ minPostgres: 14, tables: [notes] });

// @ts-expect-error 19 is not a major okmodel knows
schema({ minPostgres: 19, tables: [notes] });

// @ts-expect-error minPostgres is a major, not a string
schema({ minPostgres: "17", tables: [notes] });
