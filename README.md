<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://raw.githubusercontent.com/omqkhafi/okmodel/main/site/public/okm-white.svg"
    />
    <img
      alt="OKModel"
      src="https://raw.githubusercontent.com/omqkhafi/okmodel/main/site/public/okm.svg"
      width="240"
    />
  </picture>
</p>

<p align="center">
  <em>okmodel is a catalog-first TypeScript ORM, PostgreSQL first. The schema is the single source. Migrations and queries come from it.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/okmodel"><img alt="npm" src="https://img.shields.io/npm/v/okmodel?style=flat-square" /></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="Apache-2.0" src="https://img.shields.io/npm/l/okmodel?style=flat-square" /></a>
  <a href="https://www.postgresql.org"><img alt="PostgreSQL 15 to 18" src="https://img.shields.io/badge/PostgreSQL-15%E2%80%9318-336791?style=flat-square&logo=postgresql&logoColor=white" /></a>
  <a href="https://github.com/omqkhafi/okmodel/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/omqkhafi/okmodel/ci.yml?branch=main&label=CI&style=flat-square" /></a>
  <a href="https://github.com/omqkhafi/okmodel/commits"><img alt="last commit" src="https://img.shields.io/github/last-commit/omqkhafi/okmodel?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://okm.omqkhafi.dev"><strong>Docs</strong></a> ·
  <a href="https://okm.omqkhafi.dev/docs"><strong>Handbook</strong></a> ·
  <a href="https://okm.omqkhafi.dev/llms.txt"><code>llms.txt</code></a> ·
  <a href="https://www.npmjs.com/package/okmodel"><code>okmodel</code></a>
</p>

CI runs PostgreSQL 15 to 18. Other SQL databases are the direction. Apache-2.0.

## Install

`okmodel` has no runtime dependencies. Each driver is an optional peer. Pick the one the runtime already has.

```sh
bun add okmodel postgres
```

The other drivers:

```sh
bun add okmodel pg
bun add -D @types/pg
bun add okmodel @electric-sql/pglite
bun add okmodel
```

postgres.js is the default on Node and Bun. node-postgres is for a project that already has `pg`. PGlite runs Postgres in the process. The last line is Bun.sql, built into Bun 1.4+, and it runs only there.

Date and time columns need a `Temporal` global. Bun and Node 26 have it. On Node 22 and 24 assign a polyfill before those columns run (OKM1210 when it is missing). Example with `temporal-polyfill` (not part of the quickstart script):

```typescript
import { Temporal } from "temporal-polyfill";

globalThis.Temporal = Temporal;
```

## Quick start

Define the table, compile the schema, point the config at it, push, then connect. The same steps are on [Let's start](https://okm.omqkhafi.dev/docs/start).

`schema.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.id(),
  title: t.text(),
});

export default schema({ tables: [notes] });
```

`t.id()` stores `gen_random_uuid()`, which works on Postgres 15 to 18. For a large write-heavy table, `defaults: { id: "uuidv7" }` keeps the ids time-ordered and the index local. That choice needs Postgres 18 and `minPostgres: 18`. Omit `minPostgres` unless you need a newer major. `requires: { postgres: ">=18" }` is the same floor and is deprecated.

`okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  database: process.env.DATABASE_URL!,
});
```

`okm push` connects and creates the tables. It does not write a SQL file. A protected target refuses it (OKM1850).

```sh
bunx okm push
```

`db.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

export const db = connect(process.env.DATABASE_URL!, { schema });
```

## Basic usage

Each call on `db`. [Basic Usage](https://okm.omqkhafi.dev/docs/start/basic-usage) has one example per call.

`notes.ts`:

```ts
import { db } from "./db.ts";

// insert omits id. The row that comes back has it.
export async function createNote(title: string) {
  return db.notes.insert({ title });
}

// find returns a list and needs a limit. [0] is undefined when nothing matched.
export async function readNote(id: string) {
  const found = await db.notes.find({ where: { id }, limit: 1 });
  return found[0];
}

// one returns the row, or null. More than one match throws not_unique.
export async function readOne(id: string) {
  return db.notes.one({ where: { id } });
}

// where picks the row. A write with no where is OKM1102.
export async function renameNote(id: string, title: string) {
  await db.notes.update({ where: { id }, set: { title } });
}

export async function removeNote(id: string) {
  await db.notes.delete({ where: { id } });
}
```

`okm push` is for a database you can recreate. A shared database uses reviewed migrations: `okm generate init`, then `okm migrate apply`. `okm init` writes starter files for one package and does not connect; `okm generate init` writes the first migration and is a different command.

## 0.9

This release is the tooling train. `okm pull` writes schema files from a database. `okm import drizzle` writes them from a Drizzle schema. Several catalogs share one database through `external()` and `okm catalog export`. `describe` and `buildCatalog` are on `okmodel/migrate`. Extension packs cover `unaccent`, `hstore`, `ltree`, `btree_gist`, `btree_gin`, `fuzzystrmatch`, and `pgcrypto`. The GitHub Action posts the migration plan on a pull request. A type change that rewrites a table is five migrations, not one `ALTER COLUMN … TYPE`.

| Want…                   | Go to                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| Pull a database         | [pull](https://okm.omqkhafi.dev/docs/reference/cli#pull)               |
| Import Drizzle          | [From Drizzle](https://okm.omqkhafi.dev/docs/start/from-drizzle)       |
| Several catalogs        | [Catalogs](https://okm.omqkhafi.dev/docs/define/schema/catalogs)       |
| `describe`              | [Schema API](https://okm.omqkhafi.dev/docs/reference/schema-api)       |
| Extension packs         | [Extensions](https://okm.omqkhafi.dev/docs/define/schema/extensions)   |
| The GitHub Action       | [GitHub Action](https://okm.omqkhafi.dev/docs/reference/github-action) |
| A rewriting type change | [Type change](https://okm.omqkhafi.dev/docs/reference/type-change)     |

## Next

| Want…                       | Go to                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| One example per client call | [Basic usage](https://okm.omqkhafi.dev/docs/start/basic-usage)                                     |
| Tables, keys, and relations | [Define](https://okm.omqkhafi.dev/docs/define)                                                     |
| Every feature in one file   | [Guide](https://github.com/omqkhafi/okmodel/blob/main/docs/guide.md)                               |
| Run it in production        | [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)           |
| Install it safely           | [Using OKModel safely](https://github.com/omqkhafi/okmodel/blob/main/docs/using-okmodel-safely.md) |
| What is not built yet       | [Known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md)                 |

## Documentation

| Resource     | Link                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Docs site    | [okm.omqkhafi.dev](https://okm.omqkhafi.dev)                                                       |
| Get started  | [/docs/start](https://okm.omqkhafi.dev/docs/start)                                                 |
| Handbook     | [/docs](https://okm.omqkhafi.dev/docs)                                                             |
| Changelog    | [/changelog](https://okm.omqkhafi.dev/changelog)                                                   |
| Agents index | [/llms.txt](https://okm.omqkhafi.dev/llms.txt)                                                     |
| Size         | [`docs/size.md`](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md)                       |
| Security     | [`SECURITY.md`](https://github.com/omqkhafi/okmodel/blob/main/SECURITY.md)                         |
| Safe install | [Using OKModel safely](https://github.com/omqkhafi/okmodel/blob/main/docs/using-okmodel-safely.md) |
| Contributing | [`CONTRIBUTING.md`](https://github.com/omqkhafi/okmodel/blob/main/CONTRIBUTING.md)                 |

## License

Published on [npm](https://www.npmjs.com/package/okmodel). [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).
