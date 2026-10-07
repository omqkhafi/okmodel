# OKModel

okmodel is a catalog-first TypeScript ORM, PostgreSQL first. Other SQL databases are the direction. CI runs PostgreSQL 15 to 18. The schema is the single source. Migrations and queries come from it.

Version 0.5.0. Apache-2.0.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
  - [Configure](#configure)
  - [Schema](#schema)
  - [Push](#push)
  - [Reviewed migrations](#reviewed-migrations)
  - [One client](#one-client)
  - [Write and read](#write-and-read)
- [Core](#core)
  - [Keys](#keys)
    - [Identity](#identity)
    - [Number](#number)
    - [Uuid](#uuid)
    - [Generated in the app](#generated-in-the-app)
    - [Slug](#slug)
    - [Two columns](#two-columns)
  - [Insert](#insert)
  - [On conflict](#on-conflict)
  - [Find](#find)
  - [One](#one)
  - [Count](#count)
  - [Exists](#exists)
  - [Update](#update)
  - [Delete](#delete)
  - [Errors](#errors)
- [What is in the box](#what-is-in-the-box)
  - [Columns](#columns)
  - [Hidden](#hidden)
  - [Guarded](#guarded)
  - [Sensitive](#sensitive)
  - [Relations](#relations)
  - [Operators](#operators)
  - [Page and aggregate](#page-and-aggregate)
  - [Request filters](#request-filters)
  - [Presets](#presets)
  - [Validation](#validation)
  - [Transactions](#transactions)
  - [Batch and locks](#batch-and-locks)
  - [Traits](#traits)
  - [Archive](#archive)
  - [Tenancy](#tenancy)
  - [Extensions](#extensions)
  - [Domains](#domains)
  - [Functions](#functions)
  - [Triggers](#triggers)
  - [Views](#views)
  - [Roles and grants](#roles-and-grants)
  - [okm ext and okm doctor](#okm-ext-and-okm-doctor)
  - [Linter](#linter)
  - [Reference data](#reference-data)
  - [Backfill](#backfill)
  - [Testing](#testing)
  - [Topology](#topology)
  - [Reference app](#reference-app)
  - [Startup](#startup)
  - [Protected targets](#protected-targets)
- [Commands](#commands)
- [Check a history in CI](#check-a-history-in-ci)
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

This builds two tables, applies them, and runs one script. The script writes an author and a note, then reads the note with its author. `DATABASE_URL` is a direct Postgres URL, not a pooler.

### Configure

Point the CLI at the schema and at that URL.

`okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is not set");
}

// schema is the file. database is DATABASE_URL.
export default defineConfig({
  schema: "./schema.ts",
  database: url,
});
```

### Schema

`authors` has a unique name. `notes` stores a title and points at an author. `t.identity()` is the primary key. An insert omits the id, and the row that comes back carries it. Identity ids come back as strings by default. `t.identity({ as: "number" })` returns numbers. Push and reviewed migrations are two ways to do the same job: pick one per database.

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
    // Points at the authors primary key.
    authorId: t.bigint().references("authors"),
  },
  {
    // find({ include: { author: true } }) loads this.
    relations: { author: one("authors") },
  },
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

Generate writes a SQL file and `.okm`. On an empty database, apply installs that schema and any reference rows. A database that already has history runs the new file, so you can read it first.

```sh
bunx okm generate init
bunx okm migrate apply
```

Each step is `expand`, `contract`, or unclassified SQL. Expand is additive. Contract removes or tightens something. On an existing table the planner writes the safe form: a concurrent index, a check or foreign key as `NOT VALID` then `VALIDATE`, and `SET NOT NULL` through a validated check. A backfill step updates rows in batches and resumes after a failure. See [Backfill](#backfill).

### One client

Import `db` from this file wherever the server handles a request. The process keeps one client.

`db.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

// Import this from the server. The process keeps one client.
export const db = connect(url, { schema });
```

A server keeps this client for the life of the process. A script can use `await using`, which closes the pool at the end of the block. `db.close()` is that call on a line you choose. A pool opened with `ssl` still waits out the driver's 30 second idle timer.

### Write and read

The script writes one author and one note, then reads the note with the author attached. `await using` closes the pool when the block ends.

`script.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

await using db = connect(url, { schema });
const author = await db.authors.insert({ name: "Lin" });
const note = await db.notes.insert({ title: "hello", authorId: author.id });
// include loads the author named on the note.
const found = await db.notes.find({
  where: { id: note.id },
  limit: 1,
  include: { author: true },
});
const row = found[0];
if (author.name !== "Lin" || row?.title !== "hello" || row.author?.name !== "Lin") {
  throw new Error("insert did not return the row");
}
```

## Core

The calls below use the same schema and the same client. Read them in order. Each one uses the row the previous call wrote. The last one closes the client.

### Keys

Each kind of key is its own table.

#### Identity

The quickstart uses this. The database assigns a bigint, the insert leaves the id out, and the row comes back with that id as a string. It works on every supported Postgres version.

`identity.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// The insert leaves id out. The row comes back with it as a string.
const authors = table("authors", { id: t.identity(), name: t.text() });
export const app = schema({ tables: [authors] });
```

#### Number

`t.identity({ as: "number" })` is the same key, and the id comes back as a number.

`number.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// Same identity key. The id comes back as a number.
const counts = table("counts", { id: t.identity({ as: "number" }), name: t.text() });
export const app = schema({ tables: [counts] });
```

#### Uuid

`t.id()` is a uuid primary key. The default is `uuidv7()`, which needs Postgres 18. On an older server, `okm migrate apply` stops with OKM1812 before it runs any statement. `t.id({ default: "uuidv4" })` uses `gen_random_uuid()`, which Postgres has included since 13. `t.id({ default: "none" })` means the insert supplies the id.

#### Generated in the app

Import `uuidv4`, `uuidv7`, or `okid` from `okmodel/ids` and pass it to `.default()`. Or set `defaults.id` on `schema()` for every id column that does not choose its own. A choice on the column wins. A generator is not a database default, so changing it does not create a migration, and an insert that bypasses okmodel has to supply the value.

`generated.ts`:

```ts
import { uuidv4 } from "okmodel/ids";
import { schema, table, t } from "okmodel/pg";

// The client fills id when the insert omits it. The database stores no default.
const sessions = table("sessions", { id: t.text().primaryKey().default(uuidv4) });
export const app = schema({ tables: [sessions] });
```

#### Slug

`.primaryKey()` on one column is a key you supply, such as a slug. The insert includes it, and an update cannot change it.

`slug.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// The insert supplies slug. An update cannot change it.
const slugs = table("slugs", { slug: t.text().primaryKey() });
export const app = schema({ tables: [slugs] });
```

#### Two columns

A key of two columns is the `primaryKey` option on the table. The names are the columns, in order.

`members.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// Both columns together are the key. The insert supplies both.
const members = table(
  "members",
  { userId: t.integer(), orgId: t.integer() },
  { primaryKey: ["userId", "orgId"] },
);
export const app = schema({ tables: [members] });
```

### Insert

Insert an author, then a note that points at the author's id.

```ts
import { db } from "./db.ts";

const author = await db.authors.insert({ name: "Ada" });
// authorId is the id the insert just returned.
const note = await db.notes.insert({
  title: "hello",
  authorId: author.id,
});
if (author.name !== "Ada" || note.title !== "hello" || author.id.length === 0) {
  throw new Error("insert did not return the row");
}
```

### On conflict

The name is unique, so inserting Ada again would fail. `onConflict: "ignore"` skips that second insert. The other form updates the named columns when the row is already there.

```ts
// Ada is already there. ignore skips this insert.
await db.authors.insert({ name: "Ada" }, { onConflict: "ignore" });
```

### Find

`find` returns a list, so it needs a `limit` (OKM1101). `include` loads the author on each note. When the relation is itself a list, that include needs its own limit (OKM1105).

```ts
// limit is required. include loads the author.
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

### One

`one` returns the single note for that id. More than one match throws `not_unique`.

```ts
// One row. More than one match throws.
const single = await db.notes.one({ where: { id: note.id } });
if (single.title !== "hello") throw new Error("one did not return the note");
```

### Count

`count` returns how many notes match. It does not return the rows.

```ts
// How many notes, not the rows themselves.
if ((await db.notes.count()) < 1) throw new Error("count did not see the note");
```

### Exists

`exists` returns true when a note matches. It does not return the row.

```ts
// True or false. The row stays in the database.
if (!(await db.notes.exists({ where: { id: note.id } }))) {
  throw new Error("exists did not see the note");
}
```

### Update

`update` changes the columns in `set` on the rows that match `where`. A write with no effective predicate, including undefined values, is OKM1102. An empty `or()` branch is OKM1121. `.all(reason)` is the form that means every row.

```ts
// where picks the row. set names the new title.
await db.notes.update({ where: { id: note.id }, set: { title: "next" } });
```

### Delete

`delete` removes the rows that match `where`. A write with no effective predicate, including undefined values, is OKM1102. An empty `or()` branch is OKM1121. `.all(reason)` is the form that means every row.

```ts
// where picks the row. Without it the call is refused.
await db.notes.delete({ where: { id: note.id } });
```

### Errors

Inserting Ada again fails because the name is unique. `safe` returns that `OkmError` instead of throwing. `kind` is `unique`.

```ts
import { OkmError, safe } from "okmodel";

// safe returns the unique error instead of throwing.
const duplicate = await safe(db.authors.insert({ name: "Ada" }));
if (duplicate.ok || !(duplicate.error instanceof OkmError) || duplicate.error.kind !== "unique") {
  throw new Error("expected an OkmError of kind unique");
}
await db.close();
```

## What is in the box

Each section below is one feature you can add to the schema above.

### Columns

A column can allow only a fixed list of strings. `.picklist()` adds that check to a string column. `t.enum()` creates a Postgres enum, and every column that uses the same name shares the list. A value outside the list is OKM1210. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`columns.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const tasks = table("tasks", {
  id: t.identity(),
  // Only these three strings. Anything else is rejected.
  status: t.varchar(20).picklist(["draft", "active", "done"]),
  // A Postgres enum. Other columns named color share this list.
  color: t.enum("color", ["red", "blue"]),
});
export const app = schema({ tables: [tasks] });
```

### Hidden

A password hash should not come back on an ordinary read. `.hidden()` leaves the column out of `find` and out of `include`. Name it in `select` when that call needs it.

`hidden.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", {
  id: t.identity(),
  email: t.text(),
  // Left out of find and include. A named select still returns it.
  passwordHash: t.text().hidden(),
});
export const app = schema({ tables: [users] });
```

### Guarded

A role should not be set by whatever the caller sent. `.guarded()` drops the column from insert and update. The call that is allowed to set it passes `{ allow: ["role"] }`. Any other call is OKM1190.

`guarded.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

// role is dropped from insert and update unless the call names it in allow.
const users = table("users", { id: t.identity(), email: t.text(), role: t.text().guarded() });
const app = schema({ tables: [users] });

export async function grant(url: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.users.insert({ email: "a@b.c", role: "admin" }, { allow: ["role"] });
}
```

### Sensitive

A token can be stored and returned, and it still must not appear in a log or an error. `.sensitive()` shows `[redacted]` in logs, errors, and `inspect()`. The value in the database stays the same.

`sensitive.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const sessions = table("sessions", {
  id: t.identity(),
  // Stored as written. Logs, errors, and inspect show [redacted].
  token: t.text().sensitive(),
});
export const app = schema({ tables: [sessions] });
```

### Relations

The quickstart note points at one author. `one` is that author on the note. `many` is the list of notes on the author. `find({ include })` loads the related rows. `manyThrough` is the case with a third table in between, such as labels on a task through `taskLabels`.

`relations.ts`:

```ts
import { many, one, schema, table, t } from "okmodel/pg";

// notes is the list of notes on this author.
const authors = table(
  "authors",
  { id: t.identity() },
  { relations: { notes: many("notes", "authorId") } },
);
// author is the one author this note points at.
const notes = table(
  "notes",
  { id: t.identity(), authorId: t.bigint().references("authors") },
  { relations: { author: one("authors", "authorId") } },
);
export const app = schema({ tables: [authors, notes] });
```

### Operators

`where: { title: "hello" }` matches that exact title. A helper matches something else. `ilike` is a case-insensitive pattern, `contains` looks inside JSON, and `overlaps` looks for a shared array value. On update, `inc` adds to a number, `json.set` writes one JSON field, and `arr.append` adds one array value. The helper is a query parameter, so a JSON body cannot pretend to be one. `iStartsWith`, `iContains`, and `iEndsWith` are not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`operators.ts`:

```ts
import { arr, contains, eq, ilike, inc, json, overlaps, schema, table, t } from "okmodel/pg";

const docs = table("docs", {
  id: t.identity(),
  title: t.text(),
  n: t.integer(),
  tags: t.text().array(),
  meta: t.jsonb<{ readonly published: boolean }>(),
});
export const app = schema({ tables: [docs] });
// Read filters. A plain value would match exactly.
export const where = {
  title: ilike("%hip%"),
  n: eq(1),
  meta: contains({ published: true }),
  tags: overlaps(["news"]),
};
// Write helpers, passed inside update.
export const set = { n: inc(1), meta: json.set(["published"], true), tags: arr.append("news") };
```

### Page and aggregate

`page` returns one page of rows and a `next` cursor for the page after it. Pass that cursor back as `after`, with the same `orderBy`. A cursor from a different `orderBy` is OKM1130. `aggregate` counts or groups rows instead of returning them. A group needs a `limit`, or `.all(reason)`. There is no `having`.

`page.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function report(url: string): Promise<void> {
  await using db = connect(url, { schema: app });
  // next is the cursor for the following page. Pass it back as after.
  const page = await db.notes.page({ orderBy: { title: "asc" }, limit: 20 });
  // One row per title, with a count. groupBy needs a limit.
  await db.notes.aggregate({ count: true, groupBy: ["title"], limit: 10 });
  void page.next;
}
```

### Request filters

A request should not be able to filter on every column. `filters` names the columns and the comparisons you accept, and the columns a caller may sort by. `parse` turns that request into `where` and `orderBy`. Naming a hidden column there is OKM1123.

`filters.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", { id: t.identity(), email: t.text() });
export const app = schema({ tables: [users] });
// A request may filter email with eq, and may sort by email. Nothing else.
export const userFilters = users.filters({ allow: { email: ["eq"] }, sort: ["email"] });
```

### Presets

A filter you use often can live on the table under a name. Here `pending` means the status is `"pending"`. `db.tasks.pending().find({ limit: 20 })` applies it. It is added on top of the tenant and the archive filter, and it cannot remove either.

`presets.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const tasks = table(
  "tasks",
  { id: t.identity(), title: t.text(), status: t.text() },
  {
    // db.tasks.pending().find({ limit: 20 }) adds this filter.
    presets: { pending: (q) => q.where({ status: "pending" }) },
  },
);
export const app = schema({ tables: [tasks] });
```

### Validation

A title can be checked before it is written. `.validate()` stores the rules on the column. They run on insert and update when the schema sets `validation: true` and the file imports `okmodel/validate`. A failed check is OKM1200. `onRead` is stored and is not applied. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`validation.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { v } from "okmodel/validate";

const tasks = table("tasks", {
  id: t.identity(),
  // Trim, then require one character. A failure is OKM1200.
  title: t.varchar(8).validate([v.trim(), v.min(1, "title_required")]),
});
export const app = schema({ tables: [tasks], validation: true });
```

### Transactions

Two writes that must succeed or fail together go in `tx()`. The callback gets its own client, and every call on it shares the transaction. A `tx()` inside that callback is a savepoint. `retry` runs the callback again after a serialization failure or a deadlock.

`transactions.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function save(url: string, title: string): Promise<void> {
  await using db = connect(url, { schema: app });
  // Both calls share one transaction. tx is the client inside it.
  await db.tx(async (tx) => {
    await tx.notes.insert({ title });
  });
}
```

### Batch and locks

`batch` sends several writes as one unit. It will not run `restore`, and it will not run a write that uses `expect` (OKM1121). Inside `tx()`, `lock: "update"` makes other transactions wait to change that row, and `advisoryLock` holds a named lock until the transaction ends. A row lock outside `tx()` is OKM1830. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`batch.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function run(url: string, id: string): Promise<void> {
  await using db = connect(url, { schema: app });
  // One unit. The delete runs with the update.
  await db.batch([
    db.notes.update({ where: { id }, set: { title: "next" } }),
    db.notes.delete({ where: { title: "old" } }),
  ]);
  await db.tx(async (tx) => {
    // lock waits inside the transaction only.
    await tx.notes.find({ where: { id }, limit: 1, lock: "update", wait: "skip" });
    await tx.advisoryLock("notes");
  });
}
```

### Traits

`timestamps()` adds `createdAt` and `updatedAt` for you. Insert fills both with the current time. Update changes `updatedAt` and leaves `createdAt`. `{ enforce: "trigger" }` does that in the database as well, so a write that skips the client still updates the time.

`traits.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { timestamps } from "okmodel/traits";

// Adds createdAt and updatedAt. The insert does not set them.
const notes = table("notes", { id: t.identity(), title: t.text() }, { traits: [timestamps()] });
export const app = schema({ tables: [notes] });
```

### Archive

`archivable()` keeps the row and hides it from ordinary reads. `archive()` marks the matching rows and returns an `archiveId`. `restore({ archiveId })` brings that set back. `withArchived()` includes hidden rows. `onlyArchived()` reads only those rows. Put `cascade` on the parent and name the child tables that should archive with it. One level of children. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`archive.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";
import { archivable } from "okmodel/traits";

// cascade is on the parent. tasks archive and restore with the list.
const lists = table(
  "lists",
  { id: t.identity() },
  { traits: [archivable({ cascade: ["tasks"] })] },
);
const tasks = table(
  "tasks",
  { id: t.identity(), listId: t.bigint().references("lists") },
  { traits: [archivable()] },
);
const app = schema({ tables: [lists, tasks] });

export async function hide(url: string, id: string): Promise<void> {
  await using db = connect(url, { schema: app });
  // archive hides the row and returns the id restore uses.
  const archived = await db.lists.archive({ where: { id } });
  await db.lists.onlyArchived().restore({ archiveId: archived.archiveId });
}
```

### Tenancy

Every note belongs to one tenant. Column tenancy adds `tenantId` and puts that tenant on every read and write. `db.for({ tenantId }).notes.find({ limit: 20 })` reads one tenant. `global("shared")` marks a table every tenant can read, such as a list of countries. Row-level security is not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`tenancy.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { columnTenancy, global } from "okmodel/tenancy";

// Every read and write adds tenantId.
const notes = table("notes", { id: t.identity(), title: t.text() });
// Shared by every tenant. The reason is recorded on the table.
const countries = table("countries", { id: t.identity() }, { tenancy: global("shared") });
export const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes, countries],
});
```

### Extensions

`citext` is case-insensitive text. `pg_trgm` searches by similar chunks of text. Declare the extension on the schema and the migration creates it before the tables that use it. `gin` stores the trigram index. `okm ext check` compares the declaration with the server. A missing extension is OKM1811, and that check runs before any statement.

`extensions.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { citext as citextExtension } from "okmodel/pg/citext";
import { pgTrgm } from "okmodel/pg/pg_trgm";

const trigram = pgTrgm();
const people = table(
  "people",
  {
    email: t.citext(),
    title: t.text(),
  },
  // gin index for similar-text search on title.
  { indexes: (column) => [trigram.gin(column.title.name)] },
);
export const app = schema({ extensions: [citextExtension(), trigram], tables: [people] });
```

### Domains

A domain is a Postgres type with its own check. Here `pos` is an integer that must be greater than zero. TypeScript still sees a number. Changing the base type later is OKM1020. Write the check the way Postgres prints it, including the parentheses. A different spelling is a different check. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`domains.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const app = schema({
  // pos is an integer that must be greater than zero.
  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") })],
});
```

### Functions

`fn()` is a function that lives in the database. This one takes a title and returns text. A plpgsql function names the tables it reads in `dependsOn`, or the declaration is OKM1824. `security: "definer"` also needs a `searchPath`, or it is OKM1823. A query cannot call it as `fn.slugify(col)` yet. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`functions.ts`:

```ts
import { fn } from "okmodel/fn";
import { schema, table, t } from "okmodel/pg";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
export const app = schema({
  tables: [tasks],
  functions: [
    // plpgsql must name the tables it uses.
    fn("slug", {
      arguments: [{ name: "title", type: "text" }],
      returns: "text",
      language: "plpgsql",
      body: "begin return title; end",
      dependsOn: [tasks],
    }),
  ],
});
```

### Triggers

A trigger runs a function when a row changes. This one runs `touch` before each update of `tasks` and returns the new row. The function has to be listed on the schema. `timestamps({ enforce: "trigger" })` is the built-in form of this for `updatedAt`. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`triggers.ts`:

```ts
import { fn, trigger } from "okmodel/fn";
import { schema, table, t } from "okmodel/pg";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
const touch = fn("touch", {
  returns: "trigger",
  language: "plpgsql",
  volatility: "volatile",
  body: "begin return new; end",
  dependsOn: [tasks],
});
export const app = schema({
  tables: [tasks],
  functions: [touch],
  triggers: [
    // Runs touch before each row update and returns the new row.
    trigger("tasks_touch", {
      on: tasks,
      timing: "before",
      events: ["update"],
      level: "row",
      calls: touch,
    }),
  ],
});
```

### Views

A view is a saved query. You give it the SQL and the columns that query returns. `db.views.active.find({ limit: 20 })` reads `active`. That handle has no insert or update. There is no query-builder form yet. `okm check` reprints the query on the connected server before it compares, so a difference that is only how that server prints the query is not drift. A materialized view that refreshes while people are reading it needs a unique index, or the declaration is OKM1822. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`views.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { materializedView, view } from "okmodel/view";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
const columns = [
  { name: "id", type: "text" },
  { name: "title", type: "text" },
];
export const app = schema({
  tables: [tasks],
  views: [
    // A saved query. find reads it. The handle has no insert.
    view("active", {
      columns,
      query: "SELECT id,\n    title\n   FROM tasks\n  WHERE title IS NOT NULL",
    }),
    // Concurrent refresh needs the unique index.
    materializedView("sums", {
      columns,
      query: "SELECT id,\n    title\n   FROM tasks",
      refresh: "concurrently",
      indexes: [{ columns: ["id"], unique: true }],
    }),
  ],
});
```

### Roles and grants

The migration connects as one role and the app connects as another. `roles` names both. The app role receives select, insert, update, and delete on tables and views, select on materialized views, execute on functions, and usage plus select on sequences. Apply runs as the migration role, and switches to it with `SET ROLE` when the connection is someone else. The app role is a role you already created, unless you list it in `managed`. Grants on one column, and row-level security, are not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

`roles.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: "./schema.ts",
  database: url,
  // Apply uses the migration role. The app uses the app role.
  roles: { migration: "okm_migrate", app: "okm_app", managed: [{ name: "okm_migrate" }] },
});
```

### okm ext and okm doctor

`okm ext list` prints the extensions this server can install, and the version that is already installed. `okm ext check` compares that list with the schema. `okm doctor` lists the triggers on each table. `okm doctor OKM1811` prints what that error code means. `okm ext test` and `okm ext scaffold` are not in this version. See [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

```text
okm ext list
okm ext check
okm doctor
okm doctor OKM1811
```

### Linter

A migration plan is checked before it runs. Dropping a table, renaming a column, or adding a unique constraint on a table that already exists is an error. On an existing table the planner writes the safe form: a concurrent index, a check or foreign key as `NOT VALID` then `VALIDATE`, and `SET NOT NULL` through a validated check. The same statements written by hand, without that form, are errors. A type change that rewrites the table stays a warning. `okm generate` prints the finding and still writes the file. `okm migrate plan` and `okm check` exit non-zero on an error. `okm migrate apply` refuses with OKM1510 before any statement. The linter reads the plan and the catalogs. It does not connect. See [the linter](https://github.com/omqkhafi/okmodel/blob/main/docs/linter.md).

```text
error OKM1511 step 1: drops a table -- fix: Stop reading the table in an expand migration, then drop it in a later contract. Or allow OKM1511 with a reason.
```

```sql
-- okm-allow OKM1511: the table is empty and nothing reads it
drop table "public"."notes";
```

### Reference data

Rows the application needs are declared on the table. Apply on an empty database inserts a missing key. It does not update or delete. The rows are not part of the catalog hash, so a new key does not need a DDL migration.

`reference.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const roles = table(
  "roles",
  { code: t.text().primaryKey(), label: t.text() },
  {
    reference: {
      key: "code",
      rows: [{ code: "admin", label: "Admin" }],
    },
  },
);

export default schema({ tables: [roles] });
```

### Backfill

A backfill is one idempotent `UPDATE` in the migration file. `$1` is the exclusive lower bound and `$2` is the inclusive upper bound. Null opens that side. Apply commits one batch at a time and resumes from `okm_backfill`. There is no `okm backfill` command. A protected target refuses the step unless that invocation passes `--allow-protected`.

```sql
-- name: fill
-- class: expand

-- class: expand
-- action: backfill
-- lock: ROW EXCLUSIVE
-- transactional: false
-- backfill table="public"."notes" key="id" batch=10
update "public"."notes" set "title" = 'noted' where "title" = 'hello' and ("id" > $1 or $1 is null) and ("id" <= $2 or $2 is null);
```

### Testing

`okmodel/testing` opens a real pool. `factories` insert rows, `expectQueries` counts statements, and `isolation()` checks that tenant A cannot see tenant B. `okm seed <file>` calls the file's default export with that harness. The target must already be migrated. A protected target is refused unless `--allow-protected`.

`factory.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { testing } from "okmodel/testing";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });
const harness = await testing(app, { driver: open() });
const factories = harness.factories({
  notes: (x) => ({ title: x.words(2) }),
});
await harness.expectQueries(1, () => factories.notes.create());
const rows = await harness.db.notes.find({ limit: 5 });
if (rows.length !== 1) throw new Error("expected one note");
await harness.close();
```

`seed.ts`:

```ts
export default async function seed(t: {
  factories(definitions: {
    authors(x: { words(count: number): string }): { name: string };
    notes(x: { words(count: number): string; ref(table: string): unknown }): {
      title: string;
      authorId: unknown;
    };
  }): {
    notes: { create(): Promise<unknown> };
  };
}): Promise<void> {
  const factories = t.factories({
    authors: (x) => ({ name: x.words(2) }),
    notes: (x) => ({ title: x.words(2), authorId: x.ref("authors") }),
  });
  await factories.notes.create();
}
```

```sh
bunx okm seed seed.ts
```

### Topology

`connect({ primary, replicas }, options)` opens one pool per endpoint. An automatic read chooses a replica that has replayed at least as far as this client's last committed write. `routing.consistency` is `"session"` by default. `"eventual"` does not keep that watermark. `routing.maxLag` is a duration (`"5s"`, `"500ms"`, `"2m"`) or a size (`"16MB"`, `"512KB"`, `"1GB"`, `"4096B"`). A bare number is rejected. `find({ route: "primary" })` reads the primary. `find({ route: "replica" })` requires a replica that satisfies the same watermark and lag, and it does not fall back to the primary. `db.using("primary")` or `db.using("replica")` returns a client that forces that route. That client has no `close` and no `using`. `onRoute` receives `{ op, endpoint, reason }`. A throw from it is ignored. A string or an existing pool is one endpoint and serves either `route` from it, and it has no `using`.

The watermark is one value for the whole `connect()`. The root, `for()`, `unscoped()`, `using()`, and `reserve()` share it. A write through any of them moves it for the others. A watermark per `for()` client is not in this version.

When replicas are configured and consistency is `"session"`, a committed write reads `pg_current_wal_insert_lsn()` before its promise resolves. That is one extra round trip: on the primary pool after an autocommit `execute` or `batch`, and on the reserved connection after a successful `COMMIT`. A rollback does not read it. `"eventual"`, and a connect with no replicas, do not read it either.

`routing.select` picks among the replicas that passed health, the watermark, and `maxLag`. The default is `"weighted"`. `weighted` is smooth weighted round-robin. Equal weights take turns. A weight of `0` is rejected. `roundRobin` ignores weights and rotates through the eligible replicas. `leastConnections` uses the replica with the fewest statements already in flight on this client. A tie follows configuration order. `latencyAware` uses the replica with the lowest moving average of round-trip time. A function receives each candidate as `{ name, weight, inflight, latencyMs, lag }` and `{ op: "read" }`. `lag` is the number of bytes the replica is behind the primary, or `null` when that distance is unknown. The function returns one of those objects or its `name`. It runs only when an automatic read has two or more candidates.

A write, a batch, a transaction, or a locking read on a replica route is OKM1840. `route: "replica"` or `using("replica")` with no eligible replica is OKM1843, including a topology with no replicas. An automatic read with `routing.fallback: "error"` and no eligible replica is OKM1844. A migrate target that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845. Waiting for a connection past `timeouts.acquire` is OKM1846, and that wait stays on the endpoint's own pool. The rules are in [topology](https://github.com/omqkhafi/okmodel/blob/main/docs/topology.md).

A replica whose pool is at its maximum, with no idle connection and callers waiting, is skipped. If every replica that can serve the read is in that state, the read uses the primary and `onRoute` reports `fallback:saturated`. When healthy replicas exist and none has caught up, or none is inside `maxLag`, the reason is `fallback:behind`. `route: "replica"` still uses a saturated replica, and it still requires the watermark and `maxLag`.

`replicas.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");
const east = process.env.REPLICA_URL;
if (east === undefined || east.length === 0) throw new Error("REPLICA_URL is not set");
const west = process.env.REPLICA_URL_WEST ?? east;

const endpoints = {
  primary: url,
  replicas: [{ url: east, weight: 2, name: "east" }, west],
};

const db = await connect(endpoints, {
  schema,
  routing: { probe: "1s", fallback: "primary", consistency: "session", select: "weighted" },
  onRoute(event) {
    // { op: "read", endpoint: "east", reason: "auto:east" }
    void event;
  },
});

await db.notes.find({ limit: 50 });
await db.notes.find({ limit: 50, route: "primary" });
await db.notes.find({ limit: 50, route: "replica" });
const replica = db.using("replica");
await replica.notes.find({ limit: 50 });
await db.close();

const eventual = await connect(endpoints, {
  schema,
  routing: { consistency: "eventual" },
});
await eventual.notes.find({ limit: 50 });
await eventual.close();

for (const select of ["roundRobin", "leastConnections", "latencyAware"] as const) {
  const client = await connect(endpoints, { schema, routing: { select } });
  await client.notes.find({ limit: 1 });
  await client.close();
}

const custom = await connect(endpoints, {
  schema,
  routing: {
    select(candidates) {
      return candidates[0] ?? "east";
    },
  },
});
await custom.notes.find({ limit: 1 });
await custom.close();
```

### Reference app

The worked example is a project tracker: workspaces as tenants, archive, a function, two views, three generated migrations, and this topology. It is a private package in the repository, not on npm. CI runs it on the primary and two standbys. Board reads go to a replica. A read just after a write, with replay paused, comes back from the primary. The report uses `route: "replica"`. See the [example app](https://github.com/omqkhafi/okmodel/blob/main/docs/example-app.md) and the [reference app notes](https://github.com/omqkhafi/okmodel/blob/main/packages/reference-app/README.md).

### Startup

`connect()` compares the app with `okm_history`. A database that is ahead by expand migrations still opens. Ahead by a contract migration, or behind the app, is OKM1520 and names the migration. `okm migrate status` prints the same states, plus `failed at step N (resume with okm migrate apply)`.

### Protected targets

`protected: true` is a flag on the target, not on the name and not on `NODE_ENV`. Plan, status, check, ext check, and drift stay allowed. Expand and reference rows stay allowed. An empty protected database can be provisioned. Contract, unclassified SQL, push, backfill, and seed are OKM1850 unless that invocation passes `--allow-protected`. `okm migrate check` writes a scratch schema, so it stays refused, and the flag does not apply. Point it at a throwaway Postgres. Protection does not affect `connect()`.

## Commands

| Command                   | What it does                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `okm build`               | Validates the schema and writes `.okm/`. Does not connect.                                                                                                                                               |
| `okm check`               | Lints the schema and, after `okm_meta` exists, compares the database. Drift is OKM1520. Allowed on a protected target.                                                                                   |
| `okm generate [name]`     | Writes a SQL migration and `.okm/`. Prints lint findings and still writes the file. Offline.                                                                                                             |
| `okm dev`                 | Opens a PGlite database in `.okm/dev-db`, or a target named `dev`. It does not apply migrations.                                                                                                         |
| `okm push`                | Applies the schema directly. OKM1850 on a protected target unless `--allow-protected`.                                                                                                                   |
| `okm migrate plan <name>` | Prints each step's class and lock, plus a row estimate when the target answers. Read-only on a protected target. An error finding exits non-zero.                                                        |
| `okm migrate apply`       | Installs the head snapshot on an empty database, or runs pending files. Expand is allowed on a protected target. Contract, unclassified SQL, and backfill need `--allow-protected`.                      |
| `okm migrate check`       | Replays the history in a scratch schema and checks the previous catalog, the head, and the linter. Prints `ok N migrations`. Refused on a protected target, and `--allow-protected` does not apply.      |
| `okm migrate status`      | Prints version, catalog hash, and state. Read-only on a protected target. An unfinished backfill is listed under the table.                                                                              |
| `okm seed <file>`         | Runs the file's default export against the migrated target. OKM1850 on a protected target unless `--allow-protected`.                                                                                    |
| `okm ext list`            | Prints extensions the server can install. Read-only on a protected target.                                                                                                                               |
| `okm ext check`           | Compares installed extensions with the schema. OKM1811 if one is missing, OKM1812 if the pin is not met. Read-only on a protected target. `okm ext test` and `okm ext scaffold` are not in this version. |
| `okm doctor [code]`       | Lists triggers, or explains one error code. A role check is read-only on a protected target.                                                                                                             |
| `okm --version`           | Prints the package version.                                                                                                                                                                              |

`okmodel` and `okm` are the same command.

## Check a history in CI

`okm migrate check` is the command for a pipeline. It applies every migration into a scratch schema, plans each result back to that file's catalog, checks the previous catalog, requires the last catalog to match the schema, and lints the history. Success prints `ok N migrations`. A failure exits non-zero.

Point it at a throwaway Postgres. A protected target is refused, and `--allow-protected` does not apply. `defineConfig({ lintFrom: "<migration id>" })` skips lint for files before that id, which is how a project adopts the linter without failing on old migrations. Apply still lints pending migrations only.

The previous-catalog check is schema-level. It does not prove application behaviour. Tenant targets are not checked.

```yaml
name: migrate
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx okm migrate check
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

The config reads `DATABASE_URL`, and that target is not protected.

## Roadmap

Status is on the [board](https://github.com/users/omqkhafi/projects/1). Each release is a milestone.

- [x] [0.1](https://github.com/omqkhafi/okmodel/milestone/1) — Schema, queries, and migrations on PostgreSQL, with postgres.js and PGlite.
- [x] [0.2](https://github.com/omqkhafi/okmodel/milestone/2) — Hidden and sensitive fields, validation, traits, tenancy, archive and restore, richer relations, presets, transactions, and operators for JSON, arrays, ranges, and search.
- [x] [0.3](https://github.com/omqkhafi/okmodel/milestone/3) — Extensions, domains, functions, triggers, views, roles, and grants.
- [x] [0.4](https://github.com/omqkhafi/okmodel/milestone/4) — Safer migration plans, backfill, drift checks, provisioning, reference data, and a testing package.
- [x] [0.5](https://github.com/omqkhafi/okmodel/milestone/5) — A primary with replicas, read routing, and a reference app.
- [ ] [0.5.1](https://github.com/omqkhafi/okmodel/milestone/7) — QA fixes for 0.5.0.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release.

Each limit, with the version that lifts it, is in [known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md).

## Size

Measured on this release.

|                                              | Minified |   Gzip | Cold import |
| -------------------------------------------- | -------: | -----: | ----------: |
| Runtime entry                                |    5,288 |  2,026 |    2.347 ms |
| App startup (10 tables, one find)            |   89,751 | 29,801 |   15.061 ms |
| App startup, every 0.2 feature in use (full) |  120,132 | 39,162 |   15.956 ms |

The full app has column tenancy, `archivable()`, `timestamps()`, validation rules, `one`, `many` and `manyThrough` relations, presets, and calls `include`, `page`, `aggregate`, `tx` and `batch`. A feature costs bytes only in an app that uses it: the full app is 30,381 minified and 9,361 gzip bytes above the plain one. The runtime entry and the plain app are gated. The full app is printed, not gated. The plain app's cold import on this sample is above the 15 ms local reference. That figure is printed and is not a gate.

The rest of the measurements are in [size](https://github.com/omqkhafi/okmodel/blob/main/docs/size.md).

## Docs

- [Quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)
- [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)
- [Linter](https://github.com/omqkhafi/okmodel/blob/main/docs/linter.md)
- [Backfill](https://github.com/omqkhafi/okmodel/blob/main/docs/backfill.md)
- [Provisioning](https://github.com/omqkhafi/okmodel/blob/main/docs/provisioning.md)
- [Testing](https://github.com/omqkhafi/okmodel/blob/main/docs/testing.md)
- [Topology](https://github.com/omqkhafi/okmodel/blob/main/docs/topology.md)
- [Known limits](https://github.com/omqkhafi/okmodel/blob/main/docs/known-limits.md)
- [Changelog](https://github.com/omqkhafi/okmodel/blob/main/changelog.md)
