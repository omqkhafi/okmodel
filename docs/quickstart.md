# Quickstart

Set `DATABASE_URL` to a direct Postgres URL, not a pooler. The CI test packs the tarball, installs it in a fresh project, and runs the commands and the read and write calls in this file.

```sh
bun add okmodel postgres
```

`okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is not set");
}

export default defineConfig({
  schema: "./schema.ts",
  database: url,
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
bunx okm migrate apply
```

`run.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

const db = connect(url, { schema: app });
await db.connected;
const id = "11111111-1111-4111-8111-111111111111";
const inserted = await db.notes.insert({ id, title: "hello" });
if (inserted.title !== "hello") throw new Error("insert did not return the title");
const found = await db.notes.find({ where: { id }, limit: 5 });
if (found.length !== 1 || found[0]?.title !== "hello") throw new Error("find did not return the row");
await db.close();
```

Production targets and `requireMeta` are in [production](production.md). What 0.1 does not ship is in [known limits](known-limits.md).
