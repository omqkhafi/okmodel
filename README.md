# OKModel

Catalog-first TypeScript ORM for PostgreSQL. Version 0.1.

## Install

```sh
bun add okmodel
```

postgres.js and PGlite are optional peers. Install the one you connect with.

```sh
bun add postgres
# or
bun add @electric-sql/pglite
```

The repository docs have the [quickstart](docs/quickstart.md), the [production checklist](docs/production.md), and the [known limits](docs/known-limits.md). Those files are not in the npm tarball.

```ts
import { schema, table, t } from "okmodel/pg";
import { defineConfig } from "okmodel/migrate";

export const notes = table("notes", {
  id: t.uuid(),
  title: t.text(),
});

export const app = schema({ tables: [notes] });

export default defineConfig({ schema: "./schema.ts" });
```

```sh
bunx okm build
bunx okm generate init
```

`table` and `index` for a schema come from `okmodel/pg`. Stable, experimental, and internal exports are listed in `tests/fixtures/api-surface.json` in the repository. `okmodel/internal` has no stability promise.

A production target sets `protected: true`. A production `connect` sets `requireMeta: true`. `prepared: "named"` is not for a transaction-mode pooler.

Apache-2.0.
