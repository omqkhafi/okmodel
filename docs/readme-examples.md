# README samples

Each feature from the README. The code is the same API the tests use.

## Identity

`identity.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// The insert leaves id out. The row comes back with it as a string.
const authors = table("authors", { id: t.identity(), name: t.text() });
export const app = schema({ tables: [authors] });
```

## Number

`number.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// Same identity key. The id comes back as a number.
const counts = table("counts", { id: t.identity({ as: "number" }), name: t.text() });
export const app = schema({ tables: [counts] });
```

## Generated in the app

`generated.ts`:

```ts
import { uuidv4 } from "okmodel/ids";
import { schema, table, t } from "okmodel/pg";

// The client fills id when the insert omits it. The database stores no default.
const sessions = table("sessions", { id: t.text().primaryKey().default(uuidv4) });
export const app = schema({ tables: [sessions] });
```

## Slug

`slug.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

// The insert supplies slug. An update cannot change it.
const slugs = table("slugs", { slug: t.text().primaryKey() });
export const app = schema({ tables: [slugs] });
```

## Two columns

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

## Columns

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

## Hidden

`hidden.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", {
  id: t.identity(),
  email: t.text(),
  passwordHash: t.text().hidden(),
});
export const app = schema({ tables: [users] });
```

## Guarded

`guarded.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const users = table("users", { id: t.identity(), email: t.text(), role: t.text().guarded() });
const app = schema({ tables: [users] });

export async function grant(url: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.users.insert({ email: "a@b.c", role: "admin" }, { allow: ["role"] });
}
```

## Sensitive

`sensitive.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const sessions = table("sessions", {
  id: t.identity(),
  token: t.text().sensitive(),
});
export const app = schema({ tables: [sessions] });
```

## Relations

`relations.ts`:

```ts
import { many, one, schema, table, t } from "okmodel/pg";

const authors = table(
  "authors",
  { id: t.identity() },
  { relations: { notes: many("notes", "authorId") } },
);
const notes = table(
  "notes",
  { id: t.identity(), authorId: t.bigint().references("authors") },
  { relations: { author: one("authors", "authorId") } },
);
export const app = schema({ tables: [authors, notes] });
```

## Operators

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
export const where = {
  title: ilike("%hip%"),
  n: eq(1),
  meta: contains({ published: true }),
  tags: overlaps(["news"]),
};
export const set = { n: inc(1), meta: json.set(["published"], true), tags: arr.append("news") };
```

## Page and aggregate

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

## Request filters

`filters.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

const users = table("users", { id: t.identity(), email: t.text() });
export const app = schema({ tables: [users] });
export const userFilters = users.filters({ allow: { email: ["eq"] }, sort: ["email"] });
```

## Presets

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

## Validation

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

## Transactions

`transactions.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

export async function save(url: string, title: string): Promise<void> {
  await using db = connect(url, { schema: app });
  await db.tx(async (tx) => {
    await tx.notes.insert({ title });
  });
}
```

## Batch and locks

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

## Traits

`traits.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { timestamps } from "okmodel/traits";

const notes = table("notes", { id: t.identity(), title: t.text() }, { traits: [timestamps()] });
export const app = schema({ tables: [notes] });
```

## Archive

`archive.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { connect } from "okmodel/pg/postgresjs";
import { archivable } from "okmodel/traits";

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
  const archived = await db.lists.archive({ where: { id } });
  await db.lists.onlyArchived().restore({ archiveId: archived.archiveId });
}
```

## Tenancy

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

## Extensions

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

## Domains

`domains.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const app = schema({
  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") })],
});
```

## Functions

`functions.ts`:

```ts
import { fn } from "okmodel/fn";
import { schema, table, t } from "okmodel/pg";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
export const app = schema({
  tables: [tasks],
  functions: [
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

## Triggers

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

## Views

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
    view("active", {
      columns,
      query: "SELECT id,\n    title\n   FROM tasks\n  WHERE title IS NOT NULL",
    }),
    materializedView("sums", {
      columns,
      query: "SELECT id,\n    title\n   FROM tasks",
      refresh: "concurrently",
      indexes: [{ columns: ["id"], unique: true }],
    }),
  ],
});
```

## Roles and grants

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

## Topology

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

## okm ext and okm doctor

```text
okm ext list
okm ext check
okm doctor
okm doctor OKM1811
```
