/**
 * The query scenarios of the homepage hero. Each is a schema, some seed rows,
 * and one call. `scripts/hero-derived.ts` runs the schema and the seed on
 * PGlite with the real client, then records the SQL the call plans, the value
 * it returns, and the rules `inspect()` lists. Only the labels and notes are
 * written by hand.
 */

import type { HeroGroupId, HeroScenarioId } from "./hero-types";

/** A query as written by hand. */
export interface HeroQuerySpec {
  readonly kind: "query";
  readonly id: HeroScenarioId;
  readonly group: HeroGroupId;
  /** Tab label. */
  readonly label: string;
  /** One sentence for the foot rail. It describes what the panels show. */
  readonly note: string;
  /** Handbook page for the part of the client the query uses. */
  readonly href: string;
  /** Whole schema module. It must declare `const app`. */
  readonly schema: string;
  /** Lines of {@link schema} shown above the query. They must occur in it verbatim. */
  readonly model: string;
  /** Statements run before the query, with `db` in scope. Not shown. */
  readonly seed: string;
  /** The read or write that is shown and run. It may name variables the seed declares. */
  readonly expr: string;
}

const AUTHORS_AND_NOTES = `import { many, one, schema, table, t } from "okmodel/pg";

const authors = table(
  "authors",
  { id: t.identity(), name: t.text().unique() },
  { relations: { notes: many("notes", "authorId") } },
);

const notes = table(
  "notes",
  {
    id: t.identity(),
    title: t.text(),
    authorId: t.bigint().references("authors"),
  },
  { relations: { author: one("authors", "authorId") } },
);

const app = schema({ tables: [authors, notes] });
`;

const NOTES_MODEL = `const notes = table(
  "notes",
  {
    id: t.identity(),
    title: t.text(),
    authorId: t.bigint().references("authors"),
  },
  { relations: { author: one("authors", "authorId") } },
);`;

const SEED_NOTES = `const ada = await db.authors.insert({ name: "Ada" });
const lin = await db.authors.insert({ name: "Lin" });
await db.notes.insert({ title: "hello", authorId: ada.id });
await db.notes.insert({ title: "sql tips", authorId: ada.id });
await db.notes.insert({ title: "lunch", authorId: lin.id });
`;

const TENANT_NOTES = `import { schema, table, t } from "okmodel/pg";
import { columnTenancy } from "okmodel/tenancy";

const notes = table("notes", { id: t.identity(), title: t.text() });

const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});
`;

const ARCHIVE_NOTES = `import { schema, table, t } from "okmodel/pg";
import { archivable } from "okmodel/traits";

const notes = table("notes", { id: t.identity(), title: t.text() }, { traits: [archivable()] });

const app = schema({ tables: [notes] });
`;

const HIDDEN_USERS = `import { schema, table, t } from "okmodel/pg";

const users = table("users", {
  id: t.identity(),
  email: t.text(),
  passwordHash: t.text().hidden(),
});

const app = schema({ tables: [users] });
`;

const SEARCH_PAGES = `import { schema, table, t } from "okmodel/pg";

const pages = table("pages", {
  id: t.identity(),
  title: t.text(),
  body: t.tsvector(),
});

const app = schema({ tables: [pages] });
`;

/** Query scenarios, in walk order. */
export const HERO_QUERIES: ReadonlyArray<HeroQuerySpec> = [
  {
    kind: "query",
    id: "include",
    group: "query",
    label: "Find with a relation",
    note: "include is one lateral join, the filter is a parameter, and the limit is required",
    href: "/docs/schema/relations",
    schema: AUTHORS_AND_NOTES,
    model: NOTES_MODEL,
    seed: SEED_NOTES,
    expr: `db.notes.find({
  where: { authorId: ada.id },
  orderBy: { title: "asc" },
  limit: 5,
  include: { author: true },
})`,
  },
  {
    kind: "query",
    id: "page",
    group: "query",
    label: "Cursor page",
    note: "a page is keyset pagination: the cursor is the last row, so page two does not skip or repeat",
    href: "/docs/queries/read-rows#page",
    schema: AUTHORS_AND_NOTES,
    model: NOTES_MODEL,
    seed: SEED_NOTES,
    expr: `db.notes.page({ orderBy: { title: "asc" }, limit: 2 })`,
  },
  {
    kind: "query",
    id: "aggregate",
    group: "query",
    label: "Aggregate",
    note: "a group by is a call, not a string, and a grouped read still needs a limit",
    href: "/docs/queries/shape-results#aggregate",
    schema: AUTHORS_AND_NOTES,
    model: NOTES_MODEL,
    seed: SEED_NOTES,
    expr: `db.notes.aggregate({ groupBy: ["authorId"], count: true, limit: 10 })`,
  },
  {
    kind: "query",
    id: "search",
    group: "query",
    label: "Full-text search",
    note: "search is one option: the match and the ranking come from the same text, closest first",
    href: "/docs/queries/search-and-trees#text-search",
    schema: SEARCH_PAGES,
    model: `const pages = table("pages", {
  id: t.identity(),
  title: t.text(),
  body: t.tsvector(),
});`,
    seed: `await db.pages.insert({ title: "Lunch menu", body: "'lunch':1 'menu':2" });
await db.pages.insert({ title: "Rollback runbook", body: "'rollback':1 'runbook':2" });
await db.pages.insert({ title: "Deploy guide", body: "'deploy':1 'guide':2 'rollback':3" });
`,
    expr: `db.pages.find({ search: "deploy rollback", limit: 5 })`,
  },
  {
    kind: "query",
    id: "scoped",
    group: "query",
    label: "Scoped to a tenant",
    note: "for() adds the tenant to the statement, so the other tenant's rows cannot come back",
    href: "/docs/schema/tenancy#on-a-table",
    schema: TENANT_NOTES,
    model: `const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});`,
    seed: `const acme = "0190c5a2-8f0e-7c3a-9b2d-6e4f1a0b9c11";
const globex = "0190c5a2-8f0e-7c3a-9b2d-6e4f1a0b9c22";
await db.for({ tenantId: acme }).notes.insert({ title: "acme roadmap" });
await db.for({ tenantId: acme }).notes.insert({ title: "acme budget" });
await db.for({ tenantId: globex }).notes.insert({ title: "globex plan" });
`,
    expr: `db.for({ tenantId: acme }).notes.find({ limit: 5 })`,
  },
  {
    kind: "query",
    id: "archived",
    group: "query",
    label: "Archived rows",
    note: "an archived row is kept and skipped: every read carries the predicate, with no where from you",
    href: "/docs/schema/traits#on-one-table",
    schema: ARCHIVE_NOTES,
    model: `const notes = table("notes", { id: t.identity(), title: t.text() }, { traits: [archivable()] });`,
    seed: `await db.notes.insert({ title: "keep" });
await db.notes.insert({ title: "old draft" });
await db.notes.archive({ where: { title: "old draft" } });
`,
    expr: `db.notes.find({ limit: 5 })`,
  },
  {
    kind: "query",
    id: "hiddenRead",
    group: "query",
    label: "Hidden column",
    note: "passwordHash is stored and never selected: a plain find leaves it out of the SQL itself",
    href: "/docs/schema/visibility",
    schema: HIDDEN_USERS,
    model: `const users = table("users", {
  id: t.identity(),
  email: t.text(),
  passwordHash: t.text().hidden(),
});`,
    seed: `await db.users.insert({ email: "ada@example.com", passwordHash: "$argon2id$..." });
`,
    expr: `db.users.find({ limit: 5 })`,
  },
];
