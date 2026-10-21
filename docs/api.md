---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: []
---
# API

0.1 classifies every export as **stable**, **experimental**, or **internal**. The list CI checks is [`tests/fixtures/api-surface.json`](../tests/fixtures/api-surface.json). An export that is not in that file fails the test.

Stable exports are the application API this release commits to. Experimental exports exist and may change their behaviour when the feature arrives (`domain` is a catalog type and may still change). Internal exports are for dialect authors and the sibling entries. They are not the application API.

`okmodel` exports `OkmError`, `safe`, the row types (`Row`, `Insert`, `Update`, `Register`), and the driver types. Catalog builders are not on this entry. `table` and `index` for a schema are `okmodel/pg`.

`okmodel/internal` holds `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders, including the catalog `table` and `index`. The subpath is not an application import. It has no stability promise. Its exports are marked `@internal`.

`okmodel/pg` is the schema API: column builders, `table`, `schema`, `index`, operators, `one`, `many`, `manyThrough`, `morph`, `morphMany`, and `morphTo`. It also exports `bucket`, `matches`, `relevance`, `rowNumber`, `rank`, `denseRank`, `runningTotal`, `fragment`, `ident`, `raw`, and `explain`. `raw` and `explain` take a table handle. An app that does not import them drops them (D268). `ExplainResult` is the `explain` return type. `okmodel/traits` exports `versioned` and `sortable`. `domain` is experimental. Catalog compilation, row-type emit, Postgres error mapping, and the operator tag helpers are not exported.

`okmodel/pg/postgresjs`, `okmodel/pg/pglite`, `okmodel/pg/pg`, `okmodel/pg/bun`, and `okmodel/pg/neon` export `connect` and the pool opener for that driver. Neon `connect` returns a promise for a string, a pool, and a topology. `httpCapabilities` is the HTTP mode. The client has `close()`. A second `close()` waits on the same call. When the runtime defines `Symbol.asyncDispose`, the client implements it, and `await using` calls `close()`. A client that adopted an existing pool resolves `close()` without ending that pool.

`okmodel/migrate` exports `defineConfig`, `MigrateConfig`, `TargetInput`, `provision`, `baseline`, `describe`, and `buildCatalog`. The CLI imports the planning and apply helpers from the package. Those helpers are not exports.

`okmodel/testing` exports `testing`. It opens a real driver pool and returns factories, `expectQueries`, and `isolation`. See [testing](testing.md).

`okmodel/otel` is experimental. It exports `otel`. You pass a tracer. The package does not import OpenTelemetry. Spans use the `db.*` attributes. `db.query.summary` is the fingerprint from `inspect()`. Statement text stays off unless you set `statement: true`. Parameters and tenant ids are not attributes.

`okmodel/warnings` is experimental. It exports `warnings`. Pass the function to `connect({ warnings })`. `defineConfig({ warnings })` holds levels and project ignores. `okm check` lists those ignores and runs the schema rules OKM2101, OKM2102, and OKM2103. A project ignore may name a `target`. See [warnings](warnings.md).
