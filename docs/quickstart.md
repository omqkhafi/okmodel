# Quickstart

The CI test packs the tarball, installs it in a fresh project, and runs these files. The copies CI uses are [`schema.ts`](../tests/fixtures/quickstart/schema.ts), [`okmodel.config.ts`](../tests/fixtures/quickstart/okmodel.config.ts), and [`run.ts`](../tests/fixtures/quickstart/run.ts).

```sh
bun add okmodel @electric-sql/pglite
```

`okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
});
```

`schema.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.uuid(),
  title: t.text(),
});

export const app = schema({ tables: [notes] });
```

```sh
bunx okm build
bunx okm generate init
```

`okm migrate apply` speaks a Postgres URL. This quickstart applies the generated SQL on PGlite, then uses `connect` from `okmodel/pg/pglite`:

```ts
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
```

Production targets and `requireMeta` are in [production](production.md). What 0.1 does not ship is in [known limits](known-limits.md).
