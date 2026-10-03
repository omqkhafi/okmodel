# OKModel

okmodel is a catalog-first TypeScript ORM, PostgreSQL first. Other SQL databases are the direction. Version 0.1 supports PostgreSQL only. The schema is the single source. Migrations and queries come from it.

Version 0.1.1. Apache-2.0.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
  - [Configure](#configure)
  - [Schema](#schema)
  - [Push](#push)
  - [Reviewed migrations](#reviewed-migrations)
  - [One client](#one-client)
  - [Insert](#insert)
  - [Find](#find)
  - [Errors](#errors)
  - [Close](#close)
- [Keys](#keys)
- [Commands](#commands)
- [Roadmap](#roadmap)
- [Size](#size)
- [Docs](#docs)

## Install

Four Postgres drivers. Pick the one the runtime already has. postgres.js is the default, on Node and Bun. node-postgres is the other choice on Node and Bun when `pg` is already installed. Bun.sql is built into Bun and runs only there. PGlite is in-process, on Node and Bun.

```sh
bun add okmodel postgres
bun add okmodel pg
bun add okmodel @electric-sql/pglite
```

Bun.sql needs no extra package: `import { connect } from "okmodel/pg/bun"`. okmodel has no runtime dependencies. Each installed driver is an optional peer.

## Quickstart

`DATABASE_URL` is a direct Postgres URL, not a pooler. The client, insert, find, and error blocks are one script, `run.ts`. `script.ts` is the `await using` form. The last block calls `db.close()`.

### Configure

Point the CLI at the schema and at that URL.

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

### Schema

`t.identity()` is the primary key. An insert omits the id, and the row that comes back carries it. Identity ids come back as strings by default. `t.identity({ as: "number" })` returns numbers. Push and reviewed migrations are two ways to do the same job: pick one per database.

Ids can also be generated in the application. Import `uuidv4`, `uuidv7`, or `okid` from `okmodel/ids` and pass one to `.default()`, or set `defaults.id` on `schema()` for every id column that does not choose its own. A column choice wins. A literal stays a database default. A generator is not stored in the catalog, so changing it does not create a migration, and an insert that bypasses okmodel has to supply the value. An OKID column is text with collation C, so a sortable id orders the same everywhere. Sortable ids include the time they were created.

Tested on PostgreSQL 15 to 18.

`schema.ts`:

```ts
import { one, schema, table, t } from "okmodel/pg";

const authors = table("authors", {
  id: t.identity(),
  name: t.text().unique(),
});

const notes = table(
  "notes",
  {
    id: t.identity(),
    title: t.text(),
    authorId: t.bigint().references("authors", { columns: ["id"] }),
  },
  { relations: { author: one("authors") } },
);

const tables = [authors, notes];

export default schema({ tables });
```

### Push

Create the tables with push, which is allowed because this target is not protected.

```sh
bunx okm push
```

A protected target refuses push. Production settings are in the [production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md).

### Reviewed migrations

Generate writes a SQL file and `.okm`, and apply runs that file later so you can read the migration first.

```sh
bunx okm generate init
bunx okm migrate apply
```

### One client

This module is cached, so the process has one client.

`db.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

export const db = connect(url, { schema });
```

### Insert

Insert an author, then a note that points at the author's id.

```ts
import { db } from "./db.ts";

const author = await db.authors.insert({ name: "Ada" });
const note = await db.notes.insert({
  title: "hello",
  authorId: author.id,
});
if (author.name !== "Ada" || note.title !== "hello" || author.id.length === 0) {
  throw new Error("insert did not return the row");
}
```

### Find

Load that note and its author by the id the insert returned.

```ts
const found = await db.notes.find({
  where: { id: note.id },
  limit: 5,
  include: { author: true },
});
const row = found[0];
if (row?.title !== "hello" || row.author?.name !== "Ada") {
  throw new Error("find did not return the note and its author");
}
```

### Errors

`safe` returns the `OkmError` instead of throwing when the author name is already used.

```ts
import { OkmError, safe } from "okmodel";

const duplicate = await safe(db.authors.insert({ name: "Ada" }));
if (duplicate.ok || !(duplicate.error instanceof OkmError) || duplicate.error.kind !== "unique") {
  throw new Error("expected an OkmError of kind unique");
}
```

### Close

A script exits when its queries finish. It does not need `close()` for that. `await using` closes the pool at the end of the block. `db.close()` is that call on a line you choose. A server keeps the client and its connections. A pool opened with `ssl` still waits out the driver's 30 second idle timer.

`script.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

await using db = connect(url, { schema });
const author = await db.authors.insert({ name: "Lin" });
if (author.name !== "Lin" || author.id.length === 0) {
  throw new Error("insert did not return the row");
}
```

```ts
await db.close();
```

## Keys

`t.identity()` is a bigint identity primary key. Insert and update omit it. It works on every supported Postgres version. The quickstart uses it.

`t.id()` is a uuid primary key. The default is `uuidv7()`, which needs Postgres 18. `t.id({ default: "uuidv4" })` uses `gen_random_uuid()`, built in from Postgres 13. `t.id({ default: "none" })` takes the id on insert and omits it from update.

`.primaryKey()` on a column is a natural key. Insert supplies it. Update cannot change it. A composite key is the `primaryKey` option on the table, naming the columns in order.

## Commands

| Command                   | What it does                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `okm build`               | Validates the schema and writes `.okm/` (catalog, hash, emitted row types). `okm generate` writes those files too.           |
| `okm check`               | Reports a stale `renamedFrom` and a table file the schema does not import.                                                   |
| `okm generate [name]`     | Writes a SQL migration and `.okm/`. The name defaults to `migration`. Prints `no changes` when the schema matches.           |
| `okm dev`                 | Uses a target named `dev`, or creates a PGlite database in `.okm/dev-db`. It does not apply migrations or write the catalog. |
| `okm push`                | Applies the schema directly. Refused when the target is protected.                                                           |
| `okm migrate plan <name>` | Prints the plan and its class. The name is required.                                                                         |
| `okm migrate apply`       | Replays migration files on the database.                                                                                     |
| `okm migrate status`      | Prints version, catalog hash, and state for each target.                                                                     |
| `okm --version`           | Prints the package version.                                                                                                  |

`okmodel` and `okm` are the same command.

## Roadmap

Status is on the [board](https://github.com/users/omqkhafi/projects/1). Each release is a milestone.

- [x] [0.1](https://github.com/omqkhafi/okmodel/milestone/1) — Schema, queries, and migrations on PostgreSQL, with postgres.js and PGlite.
- [ ] [0.2](https://github.com/omqkhafi/okmodel/milestone/2) — Hidden and sensitive fields, validation, traits, tenancy, archive and restore, richer relations, presets, transactions, and operators for JSON, arrays, ranges, and search.
- [ ] [0.3](https://github.com/omqkhafi/okmodel/milestone/3) — Extensions, domains, functions, triggers, views, roles, and grants.
- [ ] [0.4](https://github.com/omqkhafi/okmodel/milestone/4) — Safer migration plans, backfill, drift checks, provisioning, reference data, and a testing package.
- [ ] [0.5](https://github.com/omqkhafi/okmodel/milestone/5) — A primary with replicas, read routing, and a reference app.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release.

Each limit, with the version that lifts it, is in [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

## Size

Measured on this release.

|                                   | Minified |   Gzip | Cold import |
| --------------------------------- | -------: | -----: | ----------: |
| Runtime entry                     |    5,525 |  2,042 |    1.758 ms |
| App startup (10 tables, one find) |   77,537 | 25,625 |    9.922 ms |

The rest of the measurements are in [size](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md).

## Docs

- [Quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)
- [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)
- [Known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md)
