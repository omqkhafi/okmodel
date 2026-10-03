/**
 * Applies the generated migration on PGlite, then reads and writes a row.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { connect, open } from "okmodel/pg/pglite";

import { app } from "./schema.ts";

const directory = ".okm/app-db";
const sqlPath = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .at(-1);
if (sqlPath === undefined) throw new Error("okm generate did not write a migration");

const statements = readFileSync(join("migrations", sqlPath), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const pool = await open({ dataDir: directory });
for (const statement of statements) await pool.execute(statement);
await pool.close();

const db = await connect(directory, { schema: app });
await db.connected;
const id = "11111111-1111-4111-8111-111111111111";
const inserted = await db.notes.insert({ id, title: "hello" });
if (inserted.title !== "hello") throw new Error("insert did not return the title");
const found = await db.notes.find({ where: { id }, limit: 5 });
if (found.length !== 1 || found[0]?.title !== "hello") throw new Error("find did not return the row");
await db.close();
console.log("ok");
