---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: [OKM1020, OKM1101, OKM1102, OKM1105, OKM1120, OKM1121, OKM1123, OKM1130, OKM1190, OKM1200, OKM1210, OKM1510, OKM1511, OKM1520, OKM1521, OKM1531, OKM1701, OKM1707, OKM1811, OKM1812, OKM1820, OKM1822, OKM1823, OKM1824, OKM1830, OKM1840, OKM1843, OKM1844, OKM1845, OKM1846, OKM1850, OKM1854]
---
# OKModel guide

okmodel is a catalog-first TypeScript ORM, PostgreSQL first. Other SQL databases are the direction. CI runs PostgreSQL 15 to 18. The schema is the single source. Migrations and queries come from it.

Apache-2.0. The published version is [okmodel on npm](https://www.npmjs.com/package/okmodel).

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
  - [Session settings](#session-settings)
  - [Typed raw SQL](#typed-raw-sql)
  - [Extensions](#extensions)
  - [Domains](#domains)
  - [Functions](#functions)
  - [Triggers](#triggers)
  - [Views](#views)
  - [Roles and grants](#roles-and-grants)
  - [okm ext and okm doctor](#okm-ext-and-okm-doctor)
  - [Sending a bundle](#sending-a-bundle)
  - [Linter](#linter)
  - [Reference data](#reference-data)
  - [Backfill](#backfill)
  - [Testing](#testing)
  - [Topology](#topology)
  - [Reference app](#reference-app)
  - [Startup](#startup)
  - [Protected targets](#protected-targets)
  - [Agent files](#agent-files)
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

The `okm` bin's shebang is node, so `bunx okm` runs it with Node even inside a Bun project. Run `bun --bun okm` when the command must use the Bun runtime (Bun.sql runs only on Bun 1.4+). A `.ts` config file under plain Node needs Node 22.18 or newer for type stripping.

Date and time columns need a `Temporal` global. Bun and Node 26 have it. Node 22 and 24 need a polyfill assigned before those codecs run. okmodel does not ship one. A missing global is OKM1210. Example with `temporal-polyfill` (not part of the quickstart script):

```typescript
import { Temporal } from "temporal-polyfill";

globalThis.Temporal = Temporal;
```

## Quickstart

This builds two tables, applies them, and runs one script. The script writes an author and a note, then reads the note with its author. `DATABASE_URL` is a direct Postgres URL, not a pooler. Port `6432` and port `6543` count as a pooler. Apply, seed, and check also refuse when the backend pid changes between two statements (OKM1854), unless `--allow-pooler` is set.

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
import { index, one, schema, table, t } from "okmodel/pg";

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
    // A foreign key needs an index that starts with its column (OKM2101).
    indexes: (columns) => [index(columns.authorId)],
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

Each step is `expand`, `contract`, or unclassified SQL. Expand is additive. Contract removes or tightens something. On an existing table the planner writes the safe form: a concurrent index, a check or foreign key as `NOT VALID` then `VALIDATE`, and `SET NOT NULL` through a validated check. A `VALIDATE` of a check on a column added in that same migration with a constant default (or a nullable column without a default) is accepted; a `VALIDATE` against an existing column still needs a reason or a widen. A backfill step updates rows in batches and resumes after a failure. See [Backfill](#backfill).

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

`t.id()` is a uuid primary key. The default is `gen_random_uuid()`, which Postgres has included since 13, so it works on every supported major. `t.id({ default: "uuidv7" })` stores `uuidv7()`. Pick that for a large write-heavy table: the ids are time-ordered and the index stays local. It needs Postgres 18 and `minPostgres: 18`. On an older server, `okm migrate apply` stops with OKM1812 before it runs any statement. `t.id({ default: "uuidv4" })` stores the same `gen_random_uuid()` as a bare call. `t.id({ default: "none" })` means the insert supplies the id. `defaults: { id: "uuidv7" }` keeps the old database default on every bare `t.id()`. `requires: { postgres: ">=18" }` is the same floor and is deprecated.

#### Generated in the app

Import `uuidv4`, `uuidv7`, or `okid` from `okmodel/ids` and pass it to `.default()`. Or set `defaults.id` on `schema()` for every id column that does not choose its own. A choice on the column wins. A generator is not a database default, so changing it does not create a migration, and an insert that bypasses okmodel has to supply the value.

`t.id({ default: uuidv4 })` is guarded. `insert({ id, name }, { allow: ["id"] })` writes that id, and a list row that omits `id` still gets one. Without `allow`, a supplied id is OKM1190. On a list, `allow` has to be exactly `["id"]` for the type to accept `id`. `t.id()` and `t.id({ default: "uuidv7" })` are database defaults. The type accepts `allow: ["id"]` on that id, and the runtime fails with OKM1190. Update does not change the key.

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
// return: true gives that row back and does not change it.
const existing = await db.authors.insert(
  { name: "Ada" },
  { onConflict: { on: "name", return: true } },
);
if (existing.id !== author.id || existing.name !== "Ada") {
  throw new Error("first-or-create did not return the existing author");
}
```

### Find

`find` returns a list, so it needs a `limit` (OKM1101). A configured `limits.find` makes that argument optional, and the library never enables the default itself. `include` loads the author on each note. When the relation is itself a list, that include needs its own limit (OKM1105).

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

`one` returns the note for that id, or null when none matches. More than one match throws `not_unique`.

```ts
// One row, or null. More than one match throws.
const single = await db.notes.one({ where: { id: note.id } });
if (single === null || single.title !== "hello") throw new Error("one did not return the note");
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
// A list sets each row in one statement. A missing id is not an error.
await db.notes.update([{ id: note.id, set: { title: "listed" } }]);
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

import { db } from "./db.ts";

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

A column can allow only a fixed list of strings. `.picklist()` adds that check to a string column. `t.enum()` creates a Postgres enum, and every column that uses the same name shares the list. A value outside the list is OKM1210.

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

A password hash should not come back on an ordinary read, and a caller should not be able to filter on it. `.hidden()` leaves the column out of `find` and out of `include`, and `where` and `orderBy` refuse it (OKM1120). Name it in `select` when that call needs it. `hidden({ filterable: true })` allows `where` and `orderBy` and still leaves it out of the default row. `filters()` still refuses a hidden column.

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

A token can be stored and returned, and it still must not appear in a log or an error. `.sensitive()` shows `[redacted]` in logs, errors, `inspect()`, and OpenTelemetry spans. Bound parameters stay off `error.cause` for every table unless `connect({ errors: { includeValues: true } })`. A unique, foreign-key, check, generic driver, or aborted-connection failure on a sensitive column stays redacted even with that opt-in (`detail`, parameters, `args`, `where`, and `internalQuery` stay off), including when postgres.js omits `table` on the error. The value in the database stays the same.

`sensitive.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const sessions = table("sessions", {
  id: t.identity(),
  // Stored as written. Logs, errors, inspect, and spans show [redacted].
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

`where: { title: "hello" }` matches that exact title. A helper matches something else. `ilike` is a case-insensitive pattern, `contains` looks inside JSON, and `overlaps` looks for a shared array value. On update, `inc` adds to a number, `json.set` writes one JSON field, and `arr.append` adds one array value. The helper is a query parameter, so a JSON body cannot pretend to be one.

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

`page` returns one page of rows and a `next` cursor for the page after it. Pass that cursor back as `after`, with the same `orderBy`. A cursor from a different `orderBy` is OKM1130. `orderBy` takes `asc`, `desc`, or `{ dir, nulls }` on every read that orders: `asc` puts NULLs last and `desc` puts them first, and `nulls: "first"` or `"last"` overrides that. `aggregate` orders by a `groupBy` field, a bucket `as`, `count`, or a `select` name. `aggregate` counts or groups rows instead of returning them. A group needs a `limit`, or `.all(reason)`. `bucket()` groups a `timestamptz` or `date` by a unit. A day or longer unit comes back as `Temporal.PlainDate`. On a `timestamptz`, a second, minute, or hour comes back as `Temporal.Instant`. Those three units are refused on a `date`. A NULL timestamp is one group: the result key is present and the value is null. `countDistinct` is a list of field names, like `sum`. It counts the different non-null values in each group and gives a number at `countDistinct.<field>`. A group with only NULLs counts 0. `select: { name: { sum: "amount" } }` names an aggregate. Each entry is one of `count: true`, `countDistinct`, `sum`, `avg`, `min`, or `max`, and gives one flat result key, so one call can hold several of the same function and column. A name that is a group field, a bucket `as`, or `count`, `countDistinct`, `sum`, `avg`, `min`, or `max` is OKM1120. `find` takes `distinct: true` with a `select` and keeps one row per different combination of those fields. NULL is one value. `orderBy` may name selected fields only. `distinctOn: [fields]` is Postgres only. It keeps the first row of each key, and `orderBy` must start with the same keys, so the keys after them pick the row each key keeps. Neither takes `include` or `search`, and `page` and `one` refuse them. `having` keeps the groups whose aggregates match, in the `where` predicate form over `count` and the `select` names, so `having: { count: gte(2), total: gt(100) }`. It needs `groupBy`, takes the comparison operators, `inList`, `notIn`, `not`, and `or()`, and cannot name a list-form aggregate. A NULL aggregate matches no comparison; `null` matches it. An `as` of `__proto__`, `constructor`, `toString`, or `hasOwnProperty` is refused.

`page.ts`:

```ts
import { bucket, gte, schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", {
  id: t.identity(),
  title: t.text(),
  createdAt: t.timestamptz().nullable(),
});
const app = schema({ tables: [notes] });

export async function report(url: string): Promise<void> {
  await using db = connect(url, { schema: app });
  // next is the cursor for the following page. Pass it back as after.
  const page = await db.notes.page({ orderBy: { title: "asc" }, limit: 20 });
  // day is a Temporal.PlainDate. A NULL createdAt is one group, and day is null.
  // countDistinct.title is how many different titles the day holds.
  const days = await db.notes.aggregate({
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    countDistinct: ["title"],
    orderBy: { day: "desc" },
    limit: 10,
  });
  // select names each aggregate. Here the first and the last title of each day.
  const named = await db.notes.aggregate({
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    select: { notes: { count: true }, first: { min: "title" }, last: { max: "title" } },
    limit: 10,
  });
  // having keeps the days with at least two notes. count is always a name.
  const busy = await db.notes.aggregate({
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    select: { first: { min: "title" } },
    having: { count: gte(2) },
    limit: 10,
  });
  // One row per different title, and the newest note for each title.
  const titles = await db.notes.find({ distinct: true, select: ["title"], limit: 10 });
  const newest = await db.notes.find({
    distinctOn: ["title"],
    orderBy: { title: "asc", createdAt: { dir: "desc", nulls: "last" } },
    limit: 10,
  });
  void page.next;
  void days;
  void named;
  void busy;
  void titles;
  void newest;
}
```

### Request filters

A request should not be able to filter on every column. `filters` names the columns and the comparisons you accept, and the columns a caller may sort by. `parse` turns that request into `where` and `orderBy`.

`filters.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", { id: t.identity(), email: t.text() });
export const app = schema({ tables: [users] });
// A request may filter email with eq, and may sort by email. Nothing else.
export const userFilters = users.filters({ allow: { email: ["eq"] }, sort: ["email"] });
```

`parse` is asynchronous because the parser loads on first use, so the handler must await it; a request key or operator that is not allowed is an input error, and a hidden column in `allow` is OKM1123 when `filters()` is called.

`request.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";

import { app, userFilters } from "./filters.ts";

export async function list(url: string, request: { query: unknown }): Promise<void> {
  await using db = connect(url, { schema: app });
  const parsed = await userFilters.parse(request.query);
  await db.users.find({ ...parsed, limit: 20 });
}
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

A title can be checked before it is written. `.validate()` stores the rules on the column. They run on insert and update when the schema sets `validation: true` and the file imports `okmodel/validate`. A failed check is OKM1200. The same rules run when those writes sit in `batch()`: validation finishes before the plan executes, and a failing rule rolls the whole batch back with OKM1200, `issues`, and `batchIndex`. `{ validate: false }`, delete, and archive stay unchanged. `onRead` is stored and is not applied.

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

`batch` sends several writes as one unit. It will not run `restore`, a write that uses `expect`, or, on `db.batch`, an update that checks `version` (OKM1121). Use `tx()` for them; `tx.batch` takes a versioned update. Validated inserts and updates belong in the same unit: their rules run while the batch plans, before any statement, and a failure is OKM1200 with `batchIndex`. Inside `tx()`, `lock: "update"` makes other transactions wait to change that row, and `advisoryLock` holds a named lock until the transaction ends. A row lock outside `tx()` is OKM1830.

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

`archivable()` keeps the row and hides it from ordinary reads. `archive()` marks the matching rows and returns an `archiveId`. `restore({ archiveId })` brings that set back. `withArchived()` includes hidden rows. `onlyArchived()` reads only those rows. Put `cascade` on the parent and name the child tables that should archive with it. One level of children.

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

Pick one strategy from `okmodel/tenancy`. Row-level security is the Postgres mechanism. In okmodel it is the fourth strategy: the column predicate stays on every statement, and the policies are the backstop when a statement drops that predicate.

| Strategy                               | Isolation                                                      | When to use                                               |
| -------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| column                                 | one key on each tenant table; `for()` fills and filters it     | each row belongs to one tenant                            |
| composite                              | every key together, in that order                              | a row belongs to an organization and a workspace          |
| path                                   | `EXISTS` along `via()`, at most three relations, on that table | the row has no tenant column; it belongs through a parent |
| rls                                    | the column predicate, plus forced row-level security           | the database must refuse a query that omits the predicate |

`rlsTenancy({ key, type: "uuid" })` takes one key. Combining it with `compositeTenancy()` or `via()` is refused when the schema is built. Policies are enabled and forced (`FORCE ROW LEVEL SECURITY`). The application role must not own the tables, be a superuser, or have `BYPASSRLS`. The first scoped call refuses otherwise (OKM1707). A scoped read is about 0.3 ms. The same read with column tenancy is about 0.06 ms. That sample is not a gate. `unscoped()` under row-level security is read-only. A write is OKM1701.

`column-tenancy.ts`:

```ts
import { uuidv4 } from "okmodel/ids";
import { schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { columnTenancy } from "okmodel/tenancy";
import { testing } from "okmodel/testing";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});
const harness = await testing(app, { driver: open() });
await harness.db.for({ tenantId: uuidv4() }).notes.find({ limit: 20 });
await harness.close();
```

`composite-tenancy.ts`:

```ts
import { uuidv4 } from "okmodel/ids";
import { schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { compositeTenancy } from "okmodel/tenancy";
import { testing } from "okmodel/testing";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({
  tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
  tables: [notes],
});
const harness = await testing(app, { driver: open() });
const scope = { organizationId: uuidv4(), workspaceId: uuidv4() };
await harness.db.for(scope).notes.find({ limit: 20 });
await harness.close();
```

`path-tenancy.ts`:

```ts
import { uuidv4 } from "okmodel/ids";
import { one, schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { columnTenancy, via } from "okmodel/tenancy";
import { testing } from "okmodel/testing";

const organizations = table("organizations", { id: t.identity() });
const projects = table(
  "projects",
  { id: t.identity(), organizationId: t.bigint().references("organizations") },
  { tenancy: via("organization"), relations: { organization: one("organizations") } },
);
const tasks = table(
  "tasks",
  { id: t.identity(), projectId: t.bigint().references("projects") },
  { tenancy: via("project.organization"), relations: { project: one("projects") } },
);
const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [organizations, projects, tasks],
});
const harness = await testing(app, { driver: open() });
await harness.db.for({ tenantId: uuidv4() }).tasks.find({ limit: 20 });
await harness.close();
```

`global-tenancy.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { columnTenancy, global } from "okmodel/tenancy";
import { testing } from "okmodel/testing";

const countries = table(
  "countries",
  { id: t.identity() },
  { tenancy: global("shared reference data") },
);
const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [countries],
});
const harness = await testing(app, { driver: open() });
await harness.db.countries.find({ limit: 20 });
await harness.close();
```

`rls-tenancy.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";
import { rlsTenancy } from "okmodel/tenancy";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});
export async function list(url: string, tenantId: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.for({ tenantId }).notes.find({ limit: 20 });
  await db.unscoped("nightly report").notes.find({ limit: 20 });
}
```

### Session settings

`okmodel/session` hands a value, usually the user id, to a row-level security policy or a trigger for the length of one transaction. `sessionSettings({ key: { name, type, required? } })` declares the settings (types `text`, `uuid`, `int`, `bool`). `connect(url, { schema, session })` adds `db.with({ ...values })`, a typed client: every `required` key is required there and the rest are optional. `with()` composes with `for()` and `unscoped()` in any order, and a later `with()` adds to an earlier one.

`session-settings.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";
import { sessionSettings } from "okmodel/session";

const docs = table("docs", { id: t.identity(), ownerId: t.uuid(), title: t.text() });
const app = schema({ casing: "snake", tables: [docs] });
const session = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
});
export async function mine(url: string, userId: string): Promise<void> {
  await using db = connect(url, { schema: app, session });
  await db.with({ userId }).docs.find({ limit: 20 });
}
```

One `select set_config($1, $2, true), ...` is the first statement of the unit's transaction, before any savepoint. The third argument is always `true`, so the value is gone after commit and after rollback and a transaction-mode pooler cannot pass it to the next client. A nested `tx()` never sets again, a read sets it on its `BEGIN READ ONLY` transaction on whichever endpoint serves it, and `batch()` starts with it. Read it in SQL as `NULLIF(current_setting('app.user_id', true), '')` before a cast: after the transaction the setting reads as an empty string, not NULL.

A name needs a dot and cannot start with `app.tenant` or `app.unscoped` or be a built-in setting. A value of the wrong type, an unknown key, a missing required key, and a client that never called `with()` when a key is required are OKM1709, before any statement. It does not authenticate: a role that can run SQL can set the same names. It is Postgres only. The MySQL family and SQLite refuse and point at column, composite, or path tenancy (OKM1860). The handbook page [Session settings](https://okm.omqkhafi.dev/docs/operate/session-settings) has the policy example.

### Typed raw SQL

`raw(db, "select ...", params)` runs a SQL string you wrote and returns typed rows. The types and the parameter and column codecs come from `.okm/raw.lock.json`, which `okm raw sync` writes by describing each static call against your database. Run `okm raw sync` after you add or change a statement, and commit both `.okm/raw.lock.json` and `.okm/raw.d.ts`. `okm check` compares the lock.

`raw-call.ts`:

```ts
import { raw } from "okmodel/pg";

const rows = await raw(db, "select id, title from notes where author_id = $1", [authorId]);
```

A literal with no entry in the lock is a type error that says to run `okm raw sync`. At runtime, a statement missing from the lock, a lock that does not parse, or a lock whose columns no longer match the result is OKM1601. The lock is read on the first typed raw call, from `.okm/` under the `catalogDir` you pass to `connect`. A runtime with no file system calls `registerRawLock(lock)` from `okmodel/pg` once at startup with the parsed lock instead.

Parameters use the codecs the typed API uses for that Postgres type (booleans, integers, `bigint` and `numeric` modes, JSON, ranges, arrays, enums by label). A parameter count that differs from the lock is OKM1602. A `write` statement runs on the primary. A `read` statement follows normal routing. Inside `tx()` both use the transaction connection. `onWrite` sees a write statement with `source: "raw"`, `op: "raw"`, and `table: null`. `onQuery` sees reads and writes with `op: "raw"`.

A client from `for()` refuses typed raw with OKM1702, because the statement is not filtered by tenant. `trusted(client, "reason")` from `okmodel/pg` returns the same client with the check lifted for the statements you run through it. The reason is required and shows as the event `tag` in the observer. A schema with no tenancy has no restriction. Raw SQL has no archive filter and no hidden-column guard: write both into the statement. A template literal with `${}` or a dynamic string stays on the older `raw(handle, cls, "read" | "write", fragment)` form.

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

A domain is a Postgres type with its own check. Here `pos` is an integer that must be greater than zero. TypeScript still sees a number. Changing the base type later is OKM1020. Write the check the way Postgres prints it, including the parentheses. A different spelling is a different check.

`domains.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const app = schema({
  // pos is an integer that must be greater than zero.
  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") })],
});
```

### Functions

`fn()` is a function that lives in the database. This one takes a title and returns text. A plpgsql function names the tables it reads in `dependsOn`, or the declaration is OKM1824. `security: "definer"` also needs a `searchPath`, or it is OKM1823. The value `fn()` returns is callable: `slug(ident("title"))` in `where`, and `slug(ident("title")).as("slug")` in `select`. `orderBy` does not accept the call.

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

A trigger runs a function when a row changes. This one runs `touch` before each update of `tasks` and returns the new row. The function has to be listed on the schema. `timestamps({ enforce: "trigger" })` is the built-in form of this for `updatedAt`.

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

A view is a saved query. You give it the SQL and the columns that query returns. `db.views.active.find({ limit: 20 })` reads `active`. That handle has no insert or update. View handles are camelCased: a view named `active_projects` reads as `db.views.activeProjects`. `okm check` reprints the query on the connected server before it compares, so a difference that is only how that server prints the query is not drift. A materialized view refreshes with `db.views.name.refresh()`, which runs `REFRESH MATERIALIZED VIEW` and returns void. The plan populates it with a plain refresh first (Postgres rejects `CONCURRENTLY` on an empty view), then refreshes concurrently when the declaration sets `refresh: "concurrently"`. A materialized view that refreshes while people are reading it needs a unique index, or the declaration is OKM1822. A view over a tenant table must expose the tenant key, or be `global("reason")`, or schema build fails with OKM1820. `isolation()` reads a tenant view and a materialized view after seeding the underlying tables. It does not insert into the view. A global view is skipped and listed with its reason.

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

`tenant-views.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { open } from "okmodel/pg/pglite";
import { columnTenancy } from "okmodel/tenancy";
import { testing } from "okmodel/testing";
import { materializedView, view } from "okmodel/view";

const tasks = table("tasks", { id: t.identity(), title: t.text() });
const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tasks],
  views: [
    view("open_tasks", {
      columns: [
        { name: "tenant_id", type: "uuid" },
        { name: "title", type: "text" },
      ],
      query: " SELECT tenant_id,\n    title\n   FROM tasks;",
    }),
    materializedView("task_titles", {
      columns: [
        { name: "tenant_id", type: "uuid" },
        { name: "title", type: "text" },
      ],
      query: " SELECT tenant_id,\n    title\n   FROM tasks;",
      indexes: [{ columns: ["title"], unique: true }],
    }),
  ],
});
const harness = await testing(app, { driver: open() });
await harness.db.views.taskTitles.refresh();
await harness.isolation();
await harness.close();
```

### Roles and grants

The migration connects as one role and the app connects as another. `roles` names both, and `roles.reporting` is the optional third. The app role receives select, insert, update, and delete on tables and views, select on materialized views, execute on functions, and usage plus select on sequences. Default privileges grant the same on objects created later. When `roles` is set, apply also revokes `EXECUTE` from `PUBLIC` on managed functions and from default privileges, so only the app role can execute them. Apply also grants that role select on `okm_meta`, and nothing else there, so `connect()` can read the stored hash. Apply creates every managed role as the connecting user first, then switches to the migration role with `SET ROLE` for the rest of the plan. A role you already created is external, unless you list it in `managed`. On an empty database, `okm migrate apply` installs the head snapshot (provision) and that same order holds: managed roles first, then schema ownership and meta grants, then `SET ROLE`.

The connecting role must be a superuser, or have `CREATEROLE`, own the target schema, and be able to `GRANT CREATE` on the database (so apply can make the migration role the schema owner). Before `SET ROLE`, apply grants itself membership on a managed migration role (`WITH SET TRUE` on Postgres 16+; a plain grant on Postgres 15). Managed-provider admin roles (RDS, Cloud SQL, Supabase) are checked separately; do not assume those attributes from this list.

`roles.reporting` can only select. It gets select on tables, views, and materialized views, usage on schemas, and default privileges for select on tables created later. It does not get insert, update, delete, or execute. A hidden column is left out of that select unless `roles.columns` lists it. Under `rlsTenancy()` this role is not `BYPASSRLS` and it is not tenant-safe against its own SQL: it sees no tenant rows until the session sets `app.tenant`, and it can set `app.unscoped` itself and then read every tenant. `unscoped()` is the application client's read escape and is not given to this role.

`roles.columns` grants select or update on named columns: `{ role, on, select, update }`. `on` is the table or view. A listed column grant on a view replaces select on the whole view for the reporting role.

`withOwner(table(...), "ignored")` keeps a table out of diffs, plans, and `okm check`. `"external"` is known and never created, altered, or dropped. A managed table that becomes either stays in the database. Drop it while it is still managed if it should go away.

`roles.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: "./schema.ts",
  database: url,
  // Apply uses the migration role. The app uses the app role.
  // okm_app is external here: create it first, or list it in managed.
  roles: {
    migration: "okm_migrate",
    app: "okm_app",
    reporting: "okm_report",
    managed: [{ name: "okm_migrate" }, { name: "okm_report", login: true }],
    columns: [{ role: "okm_report", on: "tasks", select: ["title"] }],
  },
});
```

`owner.ts`:

```ts
import { schema, table, t, withOwner } from "okmodel/pg";

const legacy = withOwner(table("legacy", { id: t.identity() }), "external");
const scratch = withOwner(table("scratch", { id: t.identity() }), "ignored");
export const app = schema({ tables: [legacy, scratch] });
```

### okm ext and okm doctor

`okm ext list` prints the extensions this server can install, and the version that is already installed. `okm ext check` compares that list with the schema. `okm ext scaffold <name>` prints a starting `extension()` definition from the server catalog. `okm ext test <file>` checks that definition and exits non-zero when a signature does not match. All four are read-only, including on a protected target. `okm doctor` lists the triggers on each table. `okm doctor OKM1811` prints what that error code means.

```text
okm ext list
okm ext check
okm ext scaffold pg_trgm
okm ext test ./pg-trgm.ts
okm doctor
okm doctor OKM1811
```

### Checking a production target

`okm doctor --production --target <name>` reports how one target differs from the production setup: `protected: true`, a pooler URL, `okm_meta`, a superuser or `BYPASSRLS` login, a login that owns the tables, zero `lock_timeout` or `statement_timeout`, the server major, and required extensions. Every query runs in one `READ ONLY` transaction, and the output never holds the URL, host, user, or password (D315). The command exits 1 when a finding is `fail`. It cannot see `connect()` options such as `requireMeta`. See [production](production.md#read-the-doctor-report).

```text
okm doctor --production --target production
okm doctor --production --target production --json
```

### Sending a bundle

`okm doctor --bundle` writes one JSON file for a tester to send by hand (O-6, D307). It needs no database and makes no network call, so it runs the same on a laptop with no connection and on a project whose database is down. It never uploads anything: the file stays where you wrote it until you attach it to a message.

```text
okm doctor --bundle
okm doctor --bundle --out ./sent/okm-bundle.json
okm doctor --bundle --force-file
```

The default path is `.okm/doctor-bundle.json`, relative to the project. `--out <file>` sets another path. An existing file is refused (exit 4) unless `--force-file` is passed. `--out -` prints the document instead of writing it. `--bundle` takes no error code and no `--target`. Do not commit the file.

The file has `bundleFormat: 1`. Keys sort at every depth, so the same project writes the same bytes. The top-level keys are:

| Key              | Holds                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapters`       | Driver packages the project declares (`postgresjs`, `pg`, `pglite`, `neon`) with the installed package version, or `null`.                              |
| `artifacts`      | Files and directories under `.okm/` from a closed list of names (`catalog.json`, `catalog.hash`, `types.d.ts`, `raw.lock.json`, `dev-db`, and the rest). A file has its SHA-256. |
| `bundleFormat`   | `1`. A change to a key name or its meaning raises it.                                                                                                   |
| `capabilities`   | The Postgres feature registry: the count, the native count, the emulated and refused keys, and the keys this schema uses.                              |
| `checks`         | The checks that need no database, run now: `codes` (sorted), `failures` (a step that could not run), `result`, `rules` (`pass` or `fail` per rule, with its severity), and `scope: "offline"`. |
| `config`         | The config file name, whether it was found and loaded, the number of targets, and how many configs tied for nearest.                                    |
| `dialect`        | `postgres`, with the `okmodel` version.                                                                                                                |
| `layout`         | Whether the project is in a workspace, how many workspace packages exist, whether the config is at the workspace root, and the migration file count.    |
| `okmodel`        | The version of the `okm` that wrote the file.                                                                                                          |
| `packageManager` | `bun`, `npm`, `pnpm`, `yarn`, or `unknown`, from the lockfile name.                                                                                    |
| `runtime`        | Node version, Bun version or `null`, operating system, and CPU architecture.                                                                          |

`checks` runs the lint and the schema rules that `okm check` and `okm migrate check` run before they connect. It does not read a record of an earlier run, and it does not replay history in a scratch schema, so a failure that needs a database (a missing extension, drift) is not in it. A finding contributes its code and severity only. Never in the file: a connection string, host, user name, URL, table or column name, SQL text, row value, a path outside the project, or an environment variable value. `okm schema doctor` prints the JSON Schema for the document (`data.bundle`).

### Linter

A migration plan is checked before it runs. Dropping a table, renaming a column, or adding a unique constraint on a table that already exists is an error. On an existing table the planner writes the safe form: a concurrent index, a check or foreign key as `NOT VALID` then `VALIDATE`, and `SET NOT NULL` through a validated check. The linter accepts that pair when the `ADD COLUMN` statement gives the column a constant default (or leaves it nullable with no default) and no statement writes the table before `VALIDATE`. A write or a volatile default in the file still fires OKM1531 when the catalog snapshot looks safe. A `VALIDATE` on an existing column is still OKM1531. The same statements written by hand, without that form, are errors. A type change that rewrites the table stays a warning. `okm generate` prints the finding, still writes the file, and exits 1 on an error finding (stderr says apply will refuse until it is fixed). `okm migrate plan` and `okm check` also exit non-zero on an error. `okm migrate apply` refuses with OKM1510 before any statement. The linter reads the plan and the catalogs. It does not connect. See [the linter](https://github.com/omqkhafi/okmodel/blob/main/docs/linter.md).

```text
error OKM1511 step 1: drops a table -- fix: Stop reading the table in an expand migration, then drop it in a later contract.
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

`okmodel/testing` opens a real pool. `factories` insert rows, `expectQueries` counts statements, and `isolation()` checks that tenant A cannot see the row it inserted for tenant B, including through a tenant view or materialized view. Each call uses a new pair of tenant ids, deletes what it inserted, and names a factory that is missing. A global table or view is skipped and listed. `okm seed <file>` calls the file's default export with that harness. The target must already be migrated. A protected target is refused unless `--allow-protected`.

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

The watermark is one value for the whole `connect()`. The root, `for()`, `unscoped()`, `using()`, and `reserve()` share it. A write through any of them moves it for the others.

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

`connect()` compares the app with `okm_history`. A database that is ahead by expand migrations still opens. Ahead by a contract migration, or behind the app, is OKM1520 and names the migration. `okm migrate status` prints the same states, plus `failed at step N (resume with okm migrate apply)`, where N is the stored step index. Apply's own `failed at step N` counts from 1, the same number the linter prints.

### Protected targets

`protected: true` is a flag on the target, not on the name and not on `NODE_ENV`. Plan, status, check, ext check, and drift stay allowed. Expand and reference rows stay allowed. An empty protected database can be provisioned. Contract, unclassified SQL, push, backfill, and seed are OKM1850 unless that invocation passes `--allow-protected`. `okm migrate check` writes a scratch schema, so it stays refused, and the flag does not apply. Point it at a throwaway Postgres. Protection does not affect `connect()`.

`okm protect add` records a fingerprint in the user store (`~/.config/okm/protected.json`, or `%APPDATA%\okm\protected.json` on Windows). That store is a union with `protected: true`: deleting the config flag leaves the fingerprint in place. A state-changing command against a stored fingerprint exits 4 without a terminal, and `--allow-protected` does not lift that. A terminal is friction, not proof of a human. The ceiling is [Protection](protection.md).

### Agent files

`okm init --agents` and `okm agents` keep three kinds of file for a coding agent, and nothing else. A block in `AGENTS.md` between `<!-- BEGIN OKMODEL v<version> -->` and `<!-- END OKMODEL -->` names the docs in `node_modules/okmodel/docs/` and the safe command order. `CLAUDE.md` is a thin `@AGENTS.md` import. The `okmodel` skill from the package goes to `.claude/skills/okmodel/` and `.agents/skills/okmodel/`, but only when that directory exists or `--agents claude` or `--agents agents` names it. `--agents block` writes the block and the import alone, and `--agents all` writes both skills.

Text outside the markers is never changed. A missing `AGENTS.md` is created with only the block. An existing `CLAUDE.md` with no import line gets the line inside a managed block, after the diff is shown. The content comes from the installed package, never from the network. The `agents` section of `.okm/init.json` records the choice, the facts the block prints, and the SHA-256 of each file `okm` wrote.

| Command | What it does |
| --- | --- |
| `okm agents status` | Prints `current`, `stale`, `missing`, or `modified` for each file. Exits 1 with OKM1881 when any file is not current. Warns when `CLAUDE.local.md` exists. |
| `okm agents update` | Rewrites the block and any unmodified skill file. Does nothing in a project that never installed them. |
| `okm agents remove` | Deletes the block, and the files whose hash still matches. A file `okm` created is deleted, and a file it only added to keeps its own text. |
| `okm init --no-agents` | Records that this project has no agent files. Later runs never ask. |

A skill file you edited is `modified`. `update` and `remove` leave it as it is and say so. `--dry-run` prints the plan and the diff and writes nothing. A change to an existing file needs `--yes`, or an answer on a terminal; without either the command exits 3 with OKM1884. `--plan-hash` applies only the plan you reviewed. A damaged marker is OKM1882 and a repeated block is OKM1883. okm refuses both and does not repair them.

The writable paths are a closed list: `AGENTS.md`, `CLAUDE.md`, the shipped skill files in the two directories above, and `.okm/init.json`. `.claude/settings*.json`, hooks, `.vscode/tasks.json`, `.cursor/rules`, and MCP entries are never written. A link is followed only when it lands on another file in that list.

A repository that uses agents should name an owner for `AGENTS.md` and `.claude/` in `CODEOWNERS`. These files steer an agent that can run `okm`, so a change to them deserves the same review as a change to CI.

## Commands

| Command                   | What it does                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `okm build`               | Validates the schema and writes `.okm/`. Does not connect.                                                                                                                                               |
| `okm check`               | Lints the schema and, with one target or `--target`, compares the database after `okm_meta` exists. Drift is OKM1520. Several targets and no `--target` only lint and print `ok`. Allowed on a protected target. |
| `okm generate [name]`     | Writes a SQL migration and `.okm/`. Prints lint findings; exits 1 on an error finding after the write. Offline.                                                                                           |
| `okm dev`                 | Opens a PGlite database in `.okm/dev-db`, or prints a target named `dev`. It does not watch, reload, or apply migrations.                                                                                 |
| `okm push`                | Applies the schema directly. OKM1850 on a protected target unless `--allow-protected`.                                                                                                                   |
| `okm migrate plan <name>` | Prints each step's class and lock, plus a row estimate when the target answers. Read-only on a protected target. An error finding exits non-zero.                                                        |
| `okm migrate apply`       | Installs the head snapshot on an empty database, or runs pending files. Expand is allowed on a protected target. Contract, unclassified SQL, and backfill need `--allow-protected`.                      |
| `okm migrate check`       | Replays the history in a scratch schema and checks the previous catalog, the head, and the linter. Prints `ok N migrations`, then the empty-table limit. Refused on a protected target, and `--allow-protected` does not apply.      |
| `okm migrate status`      | Queries every target; does not require `--target`. Stops at the first unreachable one. Read-only on a protected target. An unfinished backfill is listed under the table.                                |
| `okm seed <file>`         | Runs the file's default export against the migrated target. OKM1850 on a protected target unless `--allow-protected`.                                                                                    |
| `okm ext list`            | Prints extensions the server can install. Read-only on a protected target.                                                                                                                               |
| `okm ext check`           | Compares installed extensions with the schema. OKM1811 if one is missing, OKM1812 if the pin is not met. Read-only on a protected target.                                                                 |
| `okm ext scaffold <name>` | Prints a starting `extension()` definition from the connected catalog. `--out` writes that file and never overwrites. Read-only on a protected target.                                                    |
| `okm ext test <file>`     | Checks the file's types, operators, functions, and index methods against the server. A mismatch exits non-zero. A version the server does not meet is OKM1812. Read-only on a protected target.           |
| `okm doctor [code]`       | Lists triggers, or explains one error code. A role check is read-only on a protected target.                                                                                                             |
| `okm doctor --production` | Checks one target for production misuse and reads it only. Findings have a stable id, a severity, and a fix. Exits 1 on a `fail`. Needs `--target` when several are configured. See [production](production.md#read-the-doctor-report). |
| `okm doctor --bundle`     | Writes a local diagnostics file (`.okm/doctor-bundle.json`) for a tester to send by hand. No database, no network, no values. Refuses to replace a file without `--force-file`.                         |
| `okm protect add`         | Records the selected target's fingerprint in the user store. Does not print the URL.                                                                                                                     |
| `okm protect remove`      | Deletes that fingerprint. Requires a terminal, otherwise exit 4. Deleting `protected: true` does not do this.                                                                                            |
| `okm protect list`        | Prints stored fingerprints, or `none`.                                                                                                                                                                   |
| `okm init`                | Writes starter files for a package or workspace packages, including `limits` on `connect`. Does not connect. `--limits` adds that object to an unmodified generated client. `--agents` and `--no-agents` choose the agent files. |
| `okm agents status`       | Reports whether the AGENTS.md block, the CLAUDE.md import, and the skill are current. Exits 1 on drift.                                                                                                  |
| `okm agents update`       | Rewrites the AGENTS.md block and any unmodified skill from this package.                                                                                                                                 |
| `okm agents remove`       | Deletes the AGENTS.md block and the agent files whose hash still matches.                                                                                                                                |
| `okm --version`           | Prints the package version.                                                                                                                                                                              |

`okmodel` and `okm` are the same command.

## Check a history in CI

`okm migrate check` is the command for a pipeline. It applies every migration into a scratch schema, plans each result back to that file's catalog, checks the previous catalog, requires the last catalog to match the schema, and lints the history. Success prints `ok N migrations`, then one line that the replay uses empty tables and does not catch a step that fails only on real data. A failure exits non-zero.

Point it at a throwaway Postgres. A protected target is refused, and `--allow-protected` does not apply. Run it as a non-superuser. A superuser replay can execute `COPY ... PROGRAM` and `lo_import`. `defineConfig({ lintFrom: "<migration id>" })` skips lint for files before that id, which is how a project adopts the linter without failing on old migrations. Apply still lints pending migrations only.

`--provision` installs the head snapshot into a second scratch schema and compares it with the replay. A difference is OKM1521. The default command does not provision. A protected target is still refused. See [check migrations](https://github.com/omqkhafi/okmodel/blob/main/docs/migrate-check.md).

The previous-catalog check is schema-level. It does not prove application behaviour. Tenant targets are not checked.

A unique constraint is named from the SQL table and the SQL columns: `{table}_{columns}_key`. With casing `snake`, table `tasks`, field `id`, and tenant field `tenantId`, that name is `tasks_id_tenant_id_key`. A foreign key is `{table}_{every referencing column}_fkey`. A primary key stays `{table}_pkey`. A picklist check uses the SQL column. A named check keeps the author's name.

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
- [x] [0.5.1](https://github.com/omqkhafi/okmodel/milestone/7) — QA fixes for 0.5.0.
- [x] [0.6](https://github.com/omqkhafi/okmodel/milestone/8) — Composite, path, and row-level tenancy, column grants, a reporting role, and SQL constraint names.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release.


## Size

Measured on this release.

|                                              | Minified |   Gzip | Cold import |
| -------------------------------------------- | -------: | -----: | ----------: |
| Runtime entry                                |    5,288 |  2,026 |    1.790 ms |
| App startup (10 tables, one find)            |   90,762 | 30,139 |   10.490 ms |
| App startup, every 0.2 feature in use (full) |  121,506 | 39,741 |   12.455 ms |

The full app has column tenancy, `archivable()`, `timestamps()`, validation rules, `one`, `many` and `manyThrough` relations, presets, and calls `include`, `page`, `aggregate`, `tx` and `batch`. A feature costs bytes only in an app that uses it: the full app is 30,744 minified and 9,602 gzip bytes above the plain one. The runtime entry and the plain app are gated. The full app is printed, not gated. The plain app's cold import on this sample is under the 15 ms local reference. That figure is printed and is not a gate.

The rest of the measurements are in the repository size notes, which are not part of the published package.

## Docs

- [Quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)
- [Production checklist](https://github.com/omqkhafi/okmodel/blob/main/docs/production.md)
- [Linter](https://github.com/omqkhafi/okmodel/blob/main/docs/linter.md)
- [Backfill](https://github.com/omqkhafi/okmodel/blob/main/docs/backfill.md)
- [Provisioning](https://github.com/omqkhafi/okmodel/blob/main/docs/provisioning.md)
- [Adopt an existing database](https://github.com/omqkhafi/okmodel/blob/main/docs/adopt-existing.md)
- [Testing](https://github.com/omqkhafi/okmodel/blob/main/docs/testing.md)
- [Topology](https://github.com/omqkhafi/okmodel/blob/main/docs/topology.md)
- [Check migrations](https://github.com/omqkhafi/okmodel/blob/main/docs/migrate-check.md)
- [Changelog](https://github.com/omqkhafi/okmodel/blob/main/changelog.md)
