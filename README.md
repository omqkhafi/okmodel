# OKModel

okmodel is a catalog-first TypeScript ORM, PostgreSQL first. Other SQL databases are the direction. CI runs PostgreSQL 15 to 18. The schema is the single source. Migrations and queries come from it.

Version 0.3.0. Apache-2.0.

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
- [Keys](#keys)
- [What is in the box](#what-is-in-the-box)
  - [Columns](#columns)
  - [Reads](#reads)
  - [Writes](#writes)
  - [Hidden and sensitive fields](#hidden-and-sensitive-fields)
  - [Relations](#relations)
  - [Operators](#operators)
  - [Page and aggregate](#page-and-aggregate)
  - [Request filters](#request-filters)
  - [Presets](#presets)
  - [Validation](#validation)
  - [Transactions](#transactions)
  - [Batch and locks](#batch-and-locks)
  - [Traits and archive](#traits-and-archive)
  - [Tenancy](#tenancy)
  - [Extensions](#extensions)
  - [Domains](#domains)
  - [Functions and triggers](#functions-and-triggers)
  - [Views](#views)
  - [Roles and grants](#roles-and-grants)
  - [okm ext and okm doctor](#okm-ext-and-okm-doctor)
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

A script can use `await using`, which closes the pool at the end of the block. `db.close()` is that call on a line you choose. A server keeps the client. A pool opened with `ssl` still waits out the driver's 30 second idle timer.

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

A jsonb filter uses `contains`, and the fragment stays a parameter: `{ meta: contains({ published: true }) }`. `json.set(["published"], true)` writes that path inside `update`. The column builder is `t.json()`; the `json` import is this write namespace.

An array column uses `contains` and `overlaps` the same way. `arr.append("news")` and `arr.remove("news")` add or remove one element inside `update`.

### Errors

`safe` returns the `OkmError` instead of throwing when the author name is already used.

```ts
import { OkmError, safe } from "okmodel";

const duplicate = await safe(db.authors.insert({ name: "Ada" }));
if (duplicate.ok || !(duplicate.error instanceof OkmError) || duplicate.error.kind !== "unique") {
  throw new Error("expected an OkmError of kind unique");
}
await db.close();
```

## Keys

`t.identity()` is a bigint identity primary key. Insert and update omit it. It works on every supported Postgres version. The quickstart uses it.

`t.id()` is a uuid primary key. The default is `uuidv7()`, which needs Postgres 18; on an older server `okm migrate apply` stops with OKM1812 before it runs any statement. `t.id({ default: "uuidv4" })` uses `gen_random_uuid()`, built in from Postgres 13. `t.id({ default: "none" })` takes the id on insert and omits it from update.

`.primaryKey()` on a column is a natural key. Insert supplies it. Update cannot change it. A composite key is the `primaryKey` option on the table, naming the columns in order.

## What is in the box

The quickstart is the path above. These are the other pieces, from the 0.1 reads and writes through the 0.3 catalog.

### Columns

`t.enum(name, labels)` is a catalog type. Columns that share the name share the label list. `.picklist()` narrows a string column and adds a CHECK. A value outside the list is OKM1210. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`columns.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const tasks = table("tasks", {
  id: t.identity(),
  status: t.varchar(20).picklist(["draft", "active", "done"]),
  color: t.enum("color", ["red", "blue"]),
});
export const app = schema({ tables: [tasks] });
```

### Reads

`find` is in the quickstart and needs a `limit` (OKM1101). `one` returns one row. `count` and `exists` answer without the row. A to-many `include` needs its own limit (OKM1105).

`reads.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function load(url: string, id: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.notes.one({ where: { id } });
  await db.notes.count();
  await db.notes.exists({ where: { title: "hello" } });
}
```

### Writes

`update` and `delete` need a `where`, or `.all(reason)` (OKM1102). `onConflict` is `"error"`, `"ignore"`, or an update of named columns. `expect` throws when the count differs. A lost connection at commit is OKM1401.

`writes.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text().unique() });
const app = schema({ tables: [notes] });

export async function save(url: string, id: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.notes.insert({ title: "hello" }, { onConflict: { on: "title", update: ["title"] } });
  await db.notes.update({ where: { id }, set: { title: "next" } });
  await db.notes.delete({ where: { id } });
}
```

### Hidden and sensitive fields

`.hidden()` stays out of default selects and includes. `.guarded()` is omitted from insert and update, and setting it is OKM1190. `.sensitive()` redacts the value in logs, errors, and `inspect()`. A named `select` still returns a hidden column, and the stored value is unchanged.

`fields.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", {
  id: t.identity(),
  email: t.text(),
  role: t.text().guarded(),
  passwordHash: t.text().hidden().sensitive(),
});
export const app = schema({ tables: [users] });
```

### Relations

`one`, `many`, and `manyThrough` name another table. `find({ include })` loads them. A join is `manyThrough("labels", { through: "taskLabels" })`. Sample: [relations.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#relations).

### Operators

A filter value is a plain value or a tagged helper such as `eq`, `ilike`, `contains`, or `overlaps`. `inc` adds to a numeric column inside `update`. The helper is a parameter, so JSON cannot forge one. `iStartsWith`, `iContains`, and `iEndsWith` are not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md). Sample: [operators.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#operators).

### Page and aggregate

`page({ orderBy, limit, after })` returns `{ items, next }`. The cursor is a keyset on `orderBy` plus the primary key. A cursor from another `orderBy` is OKM1130. `aggregate` returns grouped rows. `groupBy` needs a `limit` or `.all(reason)`. There is no `having`.

`page.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function report(url: string): Promise<void> {
  await using db = connect(url, { schema: app });
  const page = await db.notes.page({ orderBy: { title: "asc" }, limit: 20 });
  await db.notes.aggregate({ count: true, groupBy: ["title"], limit: 10 });
  void page.next;
}
```

### Request filters

`table.filters({ allow, sort })` is the allowlist for a request. `parse` turns that input into `where` and `orderBy`. A hidden field in `allow`, `sort`, or `relations` is OKM1123.

`filters.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", { id: t.identity(), email: t.text() });
export const app = schema({ tables: [users] });
export const userFilters = users.filters({ allow: { email: ["eq"] }, sort: ["email"] });
```

### Presets

A preset is a named filter on the table. `db.tasks.pending().find({ limit: 20 })` applies it after the tenant predicate and the active set, and it cannot remove either.

`presets.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const tasks = table(
  "tasks",
  { id: t.identity(), title: t.text(), status: t.text() },
  {
    presets: { pending: (q) => q.where({ status: "pending" }) },
  },
);
export const app = schema({ tables: [tasks] });
```

### Validation

`.validate()` stores rules on a column. They run on insert and update when the schema sets `validation: true` and the file imports `okmodel/validate`. A failed check is OKM1200. `onRead` is stored and is not applied. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`validation.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { v } from "okmodel/validate";

const tasks = table("tasks", {
  id: t.identity(),
  title: t.varchar(8).validate([v.trim(), v.min(1, "title_required")]),
});
export const app = schema({ tables: [tasks], validation: true });
```

### Transactions

`tx()` runs the callback in one transaction. A nested `tx()` is a savepoint. `retry` runs the callback again after a serialization failure or a deadlock. Sample: [transactions.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#transactions).

### Batch and locks

`batch` runs writes as one unit. It refuses `restore` and any write that carries `expect` (OKM1121) before it sends a statement. Inside `tx()`, `find({ lock })` adds `FOR UPDATE` or `FOR SHARE`, and `advisoryLock` holds a transaction lock. Outside `tx()`, a row lock is OKM1830. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`batch.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function run(url: string, id: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.batch([
    db.notes.update({ where: { id }, set: { title: "next" } }),
    db.notes.delete({ where: { title: "old" } }),
  ]);
  await db.tx(async (tx) => {
    await tx.notes.find({ where: { id }, limit: 1, lock: "update", wait: "skip" });
    await tx.advisoryLock("notes");
  });
}
```

### Traits and archive

`timestamps()` adds `createdAt` and `updatedAt`. `archivable()` hides a row from ordinary reads. `archive()` returns `{ count, archiveId }`, and `restore()` brings back rows that share that id. `withArchived()` and `onlyArchived()` change that view. Cascade names direct children only. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md). Sample: [traits.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#traits-and-archive).

### Tenancy

Column tenancy adds a tenant column and keeps each statement inside one tenant. `db.for({ tenantId }).notes.find({ limit: 20 })` reads that tenant. `global("reason")` opts a table out. Row-level security is not in 0.3. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`tenancy.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { columnTenancy, global } from "okmodel/tenancy";

const notes = table("notes", { id: t.identity(), title: t.text() });
const countries = table("countries", { id: t.identity() }, { tenancy: global("shared") });
export const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes, countries],
});
```

### Extensions

`citext()` and `pgTrgm()` declare extensions. The plan creates them before the tables that use them. `pgTrgm().gin()` and `.gist()` store a trigram index. `okm ext check` compares the declaration with the server. A missing extension is OKM1811 before any statement.

`extensions.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { citext as citextExtension } from "okmodel/pg/citext";
import { pgTrgm } from "okmodel/pg/pg_trgm";

const trigram = pgTrgm();
const people = table(
  "people",
  { email: t.citext(), title: t.text() },
  { indexes: (column) => [trigram.gin(column.title.name)] },
);
export const app = schema({ extensions: [citextExtension(), trigram], tables: [people] });
```

### Domains

`t.domain(name, base, check)` is a column type. The TypeScript type is the base column's. Changing the base is OKM1020. Write the check the way Postgres prints it. A difference of parentheses is still a check change. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`domains.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const app = schema({
  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") })],
});
```

### Functions and triggers

`fn()` declares a function. `trigger("tasks_touch", { on: tasks, timing: "before", events: ["update"], level: "row", calls })` declares a trigger. plpgsql without `dependsOn` is OKM1824, and `security: "definer"` without `searchPath` is OKM1823. A typed call such as `fn.slugify(col)` is not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md). Sample: [functions.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#functions-and-triggers).

### Views

A view is SQL plus a declared column list. `db.views.active.find({ limit: 20 })` reads it, and writes are not on that handle. The query builder form is not in this version, and the stored query is the server reprint. `materializedView` with `refresh: "concurrently"` needs a unique index (OKM1822). See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md). Sample: [views.ts](https://github.com/omqkhafi/okmodel/blob/main/docs/readme-examples.md#views).

### Roles and grants

`roles` grants the application role `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on tables and views, `SELECT` on materialized views, `EXECUTE` on functions, and `USAGE` plus `SELECT` on sequences. Apply runs as the migration role and issues one `SET ROLE` when that role is not the current user. The app role is external unless it is listed in `managed`. Column-level grants and row-level security are not in 0.3. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`roles.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: "./schema.ts",
  database: url,
  roles: { migration: "okm_migrate", app: "okm_app", managed: [{ name: "okm_migrate" }] },
});
```

### okm ext and okm doctor

`okm ext list` prints the extensions the connected server can install and the version that is installed. `okm ext check` compares those versions with the schema. `okm doctor` lists the triggers on each table. `okm doctor OKM1811` prints that code. `okm ext test` and `okm ext scaffold` are not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

```text
okm ext list
okm ext check
okm doctor
okm doctor OKM1811
```

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
| `okm ext list`            | Prints the extensions the connected server can install and the version that is installed.                                    |
| `okm ext check`           | Compares those versions with the schema. A missing extension is OKM1811. A pin the server does not meet is OKM1812.          |
| `okm doctor [code]`       | Lists the triggers on each table. A code argument prints that code.                                                          |
| `okm --version`           | Prints the package version.                                                                                                  |

`okmodel` and `okm` are the same command.

## Roadmap

Status is on the [board](https://github.com/users/omqkhafi/projects/1). Each release is a milestone.

- [x] [0.1](https://github.com/omqkhafi/okmodel/milestone/1) — Schema, queries, and migrations on PostgreSQL, with postgres.js and PGlite.
- [x] [0.2](https://github.com/omqkhafi/okmodel/milestone/2) — Hidden and sensitive fields, validation, traits, tenancy, archive and restore, richer relations, presets, transactions, and operators for JSON, arrays, ranges, and search.
- [x] [0.3](https://github.com/omqkhafi/okmodel/milestone/3) — Extensions, domains, functions, triggers, views, roles, and grants.
- [ ] [0.4](https://github.com/omqkhafi/okmodel/milestone/4) — Safer migration plans, backfill, drift checks, provisioning, reference data, and a testing package.
- [ ] [0.5](https://github.com/omqkhafi/okmodel/milestone/5) — A primary with replicas, read routing, and a reference app.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release.

Each limit, with the version that lifts it, is in [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

## Size

Measured on this release.

|                                              | Minified |   Gzip | Cold import |
| -------------------------------------------- | -------: | -----: | ----------: |
| Runtime entry                                |    5,288 |  2,026 |    1.794 ms |
| App startup (10 tables, one find)            |   89,465 | 29,723 |   10.554 ms |
| App startup, every 0.2 feature in use (full) |  119,940 | 39,123 |   12.663 ms |

The full app has column tenancy, `archivable()`, `timestamps()`, validation rules, `one`, `many` and `manyThrough` relations, presets, and calls `include`, `page`, `aggregate`, `tx` and `batch`. A feature costs bytes only in an app that uses it: the full app is 30,475 minified and 9,400 gzip bytes above the plain one. The runtime entry and the plain app are gated. The full app is printed, not gated.

The rest of the measurements are in [size](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md).

## Docs

- [Quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)
- [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)
- [Known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md)
- [Changelog](https://github.com/omqkhafi/okmodel/blob/main/changelog.md)
- [Design spec](https://github.com/omqkhafi/okmodel/blob/main/docs/okmodel-api-design.md)
