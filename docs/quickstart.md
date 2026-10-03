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

`t.identity()` is the primary key. An insert omits the id, and the row that comes back carries it. Identity ids come back as strings by default. `t.identity({ as: "number" })` returns numbers. Push and reviewed migrations are two ways to do the same job: pick one per database. This file uses reviewed migrations.

Tested on PostgreSQL 17.

`schema.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.identity(),
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
const inserted = await db.notes.insert({ title: "hello" });
if (inserted.title !== "hello" || inserted.id.length === 0) {
  throw new Error("insert did not return the title");
}
const found = await db.notes.find({ where: { id: inserted.id }, limit: 5 });
if (found.length !== 1 || found[0]?.title !== "hello") throw new Error("find did not return the row");
await db.close();
```

Close the client when the script is finished. Without `db.close()` the script exits after about 30 seconds (the idle timeout).

Production targets and `requireMeta` are in [production](production.md). What 0.1 does not ship is in [known limits](known-limits.md).
