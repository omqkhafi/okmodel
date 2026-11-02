<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omqkhafi/okmodel/main/site/public/okm-white.svg" />
    <img alt="OKModel" src="https://raw.githubusercontent.com/omqkhafi/okmodel/main/site/public/okm.svg" width="220" />
  </picture>
</p>

<p align="center">
  <em>okmodel is a TypeScript ORM for PostgreSQL 15 to 18 with no runtime dependencies. It is built around one schema, safe queries, and reviewed migrations.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/okmodel"><img alt="npm" src="https://img.shields.io/npm/v/okmodel?style=flat-square" /></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="Apache-2.0" src="https://img.shields.io/npm/l/okmodel?style=flat-square" /></a>
  <a href="https://www.postgresql.org"><img alt="PostgreSQL 15–18" src="https://img.shields.io/badge/PostgreSQL-15%E2%80%9318-336791?style=flat-square&logo=postgresql&logoColor=white" /></a>
  <a href="https://github.com/omqkhafi/okmodel/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/omqkhafi/okmodel/ci.yml?branch=main&label=CI&style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://okm.omqkhafi.dev/docs"><strong>Documentation</strong></a> ·
  <a href="https://okm.omqkhafi.dev/llms.txt"><strong>AI Resources</strong></a> ·
  <a href="https://www.npmjs.com/package/okmodel"><strong>npm</strong></a>
</p>

OKModel provides a typed data layer for PostgreSQL 15–18 with no runtime dependencies. One schema drives your queries, migrations, and database checks.

## Why OKModel

- **One source of truth** — define your database schema once.
- **Safe by default** — unbounded reads and unfiltered writes are refused unless explicitly configured.
- **Type-safe queries** — work with your schema through TypeScript.
- **Reviewed migrations** — generate, inspect, and apply database changes.
- **Production safeguards** — protected targets, drift detection, tenant isolation, and operational checks.
- **Multiple drivers** — use supported PostgreSQL drivers with the same schema and query API.

## Install

postgres.js is the default on Node.js and Bun:

```sh
bun add okmodel postgres
```

The other drivers:

```sh
# node-postgres
bun add okmodel pg
bun add -D @types/pg

# PGlite
bun add okmodel @electric-sql/pglite

# Bun.sql (Bun 1.4+)
bun add okmodel
```

Date and time columns need a `Temporal` global. Bun and Node 26 have it. On Node 22 and 24, assign a polyfill such as `temporal-polyfill` to `globalThis.Temporal` before those columns run.

## Quick Start

Define your schema:

`schema.ts`:

```ts
import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.id(),
  title: t.text(),
});

export default schema({ tables: [notes] });
```

Configure your database:

`okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  database: process.env.DATABASE_URL!,
});
```

Generate and apply your initial migration:

```sh
bunx okm generate init
bunx okm migrate apply
```

Connect to your database:

`db.ts`:

```ts
import { connect } from "okmodel/pg/postgresjs";
import schema from "./schema.ts";

export const db = connect(process.env.DATABASE_URL!, { schema });
```

Query your data:

```ts
const note = await db.notes.insert({ title: "Hello OKModel" });
const notes = await db.notes.find({ limit: 50 });
```

## Documentation

Explore the documentation:

- [Get Started](https://okm.omqkhafi.dev/docs/start)
- [Concepts](https://okm.omqkhafi.dev/docs/concepts/how-okmodel-works)
- [Schema](https://okm.omqkhafi.dev/docs/schema/tables)
- [Queries](https://okm.omqkhafi.dev/docs/queries)
- [Migrations](https://okm.omqkhafi.dev/docs/migrations)
- [Operate](https://okm.omqkhafi.dev/docs/operate/production-checklist)
- [Reference](https://okm.omqkhafi.dev/docs/reference/config)

## License

Apache-2.0
