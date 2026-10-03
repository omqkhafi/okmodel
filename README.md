# OKModel

Catalog-first TypeScript ORM for PostgreSQL. The schema is a catalog: queries and migrations are planned from it, and `connect` checks that catalog hash. No runtime dependencies. postgres.js and PGlite are optional peers.

Version 0.1.1. Apache-2.0.

## Install

Install okmodel and one driver peer.

```sh
bun add okmodel postgres
```

PGlite is the in-process peer:

```sh
bun add okmodel @electric-sql/pglite
```

## Quickstart

`DATABASE_URL` is a direct Postgres URL, not a pooler. The repository test packs the tarball and runs the files and commands in this section.

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
import { one, schema, table, t } from "okmodel/pg";

export const authors = table("authors", {
  id: t.uuid().unique(),
  name: t.text(),
});

export const notes = table(
  "notes",
  {
    id: t.uuid().unique(),
    title: t.text(),
    authorId: t.uuid().references("authors", { columns: ["id"] }),
  },
  { relations: { author: one("authors") } },
);

export const app = schema({ tables: [authors, notes] });
```

```sh
bunx okm build
bunx okm generate
bunx okm migrate apply
```

`okm dev` opens a local PGlite database in `.okm/dev-db` when no target is named `dev`. It does not apply migrations. `okm migrate apply` does.

`run.ts`:

```ts
import { OkmError, safe } from "okmodel";
import { connect } from "okmodel/pg/postgresjs";

import { app } from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

const db = connect(url, { schema: app });
await db.connected;

const authorId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";

const author = await db.authors.insert({ id: authorId, name: "Ada" });
if (author.name !== "Ada") throw new Error("insert did not return the name");

const note = await db.notes.insert({ id: noteId, title: "hello", authorId });
if (note.title !== "hello") throw new Error("insert did not return the title");

const found = await db.notes.find({
  where: { id: noteId },
  limit: 5,
  include: { author: true },
});
const row = found[0];
if (row?.title !== "hello" || row.author?.name !== "Ada") {
  throw new Error("find did not return the note and its author");
}

const duplicate = await safe(db.notes.insert({ id: noteId, title: "again", authorId }));
if (duplicate.ok || !(duplicate.error instanceof OkmError) || duplicate.error.kind !== "unique") {
  throw new Error("expected an OkmError of kind unique");
}

await db.close();
```

A production target sets `protected: true`. A production `connect` sets `requireMeta: true`. `prepared: "named"` is not for a transaction-mode pooler. The [production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md) has the details.

`table` and `index` for a schema come from `okmodel/pg`. `defineConfig` comes from `okmodel/migrate`.

## Commands

| Command                   | What it does                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `okm build`               | Validates the schema and writes `.okm/` (catalog, hash, emitted row types).                            |
| `okm check`               | Reports a stale `renamedFrom` and a table file the schema does not import.                             |
| `okm generate [name]`     | Writes a SQL migration. The name defaults to `migration`. Prints `no changes` when the schema matches. |
| `okm dev`                 | Uses a target named `dev`, or creates a PGlite database in `.okm/dev-db`.                              |
| `okm push`                | Applies the schema directly. Refused when the target is protected.                                     |
| `okm migrate plan <name>` | Prints the plan and its class. The name is required.                                                   |
| `okm migrate apply`       | Replays migration files on the database.                                                               |
| `okm migrate status`      | Prints version, catalog hash, and state for each target.                                               |
| `okm --version`           | Prints the package version.                                                                            |

`okmodel` and `okm` are the same command.

## What 0.1 does not have

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release.

The [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md) list each item with its prompt. The short form:

| Item                                                                                                                                           | Version |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `.hidden()` left out of default selects (the flag is already recorded), `.sensitive()`, `.validate()`, tenancy, traits, presets, `manyThrough` | 0.2     |
| Domains, extensions, functions, triggers, views                                                                                                | 0.3     |
| `reference` rows, `okmodel/testing`                                                                                                            | 0.4     |
| `morph`, `computed`, `policies`                                                                                                                | later   |

`okm migrate apply` replays migration files. It does not install a head snapshot.

## Size

Numbers from `bun run size` on this release. Byte gates fail in CI. Cold import is the median of five fresh Node processes. The failing cold-import gate is 25 ms, and it applies to the runtime entry only.

| Graph                                 | Minified |   Gzip | Cold import | Gate                                                     |
| ------------------------------------- | -------: | -----: | ----------: | -------------------------------------------------------- |
| Runtime entry `okmodel`               |    5,525 |  2,042 |    1.758 ms | 6,100 / 2,250 bytes, CI cold import 25 ms                |
| App startup (10 tables, one find)     |   77,537 | 25,625 |    9.922 ms | 79,849 / 26,410 bytes. Cold import is printed, not gated |
| App startup, driver stubbed           |          |        |    4.101 ms | local reference 15 ms, not gated                         |
| App total graph, lazy chunks included |  112,033 | 36,204 |             | printed, not gated                                       |

First find on this sample was 0.425 ms. First include was 0.800 ms. Those are one run, not a gate.

Connect entries and the rest of the table are in [size](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md).

## Docs

- [Quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)
- [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)
- [Known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md)
