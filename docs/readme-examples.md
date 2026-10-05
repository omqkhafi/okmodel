# README samples

The longer samples from the README. Each one is the same API the tests use.

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
import { contains, overlaps, schema, table, t } from "okmodel/pg";

const docs = table("docs", {
  id: t.identity(),
  title: t.text(),
  tags: t.text().array(),
  meta: t.jsonb<{ readonly published: boolean }>(),
});
export const app = schema({ tables: [docs] });
export const where = {
  title: contains("hip"),
  meta: contains({ published: true }),
  tags: overlaps(["news"]),
};
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

## Traits and archive

`traits.ts`:

```ts
import { schema, table, t } from "okmodel/pg";
import { archivable, timestamps } from "okmodel/traits";

const lists = table(
  "lists",
  { id: t.identity() },
  { traits: [archivable({ cascade: ["tasks"] }), timestamps()] },
);
const tasks = table(
  "tasks",
  { id: t.identity(), listId: t.bigint().references("lists") },
  { traits: [archivable()] },
);
export const app = schema({ tables: [lists, tasks] });
```

## Functions and triggers

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
