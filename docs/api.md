# API

0.1 classifies every export as **stable**, **experimental**, or **internal**. The list CI checks is [`tests/fixtures/api-surface.json`](../tests/fixtures/api-surface.json). An export that is not in that file fails the test.

Stable exports are the application API this release commits to. Experimental exports exist and may change their behaviour when the feature arrives (`domain` throws OKM1061 until 0.3). Internal exports are for dialect authors and the sibling entries. They are not the application API.

`okmodel` exports `OkmError`, `safe`, the row types (`Row`, `Insert`, `Update`, `Register`), and the driver types. Catalog builders are not on this entry. `table` and `index` for a schema are `okmodel/pg`.

`okmodel/internal` holds `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders, including the catalog `table` and `index`. The subpath is not an application import. It has no stability promise. Its exports are marked `@internal`.

`okmodel/pg` is the schema API: column builders, `table`, `schema`, `index`, operators, `one`, `many`, and `manyThrough`. `domain` is experimental. Catalog compilation, row-type emit, Postgres error mapping, and the operator tag helpers are not exported.

`okmodel/pg/postgresjs` and `okmodel/pg/pglite` export `connect` and the pool opener for that driver. The client has `close()`. A second `close()` waits on the same call. When the runtime defines `Symbol.asyncDispose`, the client implements it, and `await using` calls `close()`. A client that adopted an existing pool resolves `close()` without ending that pool.

`okmodel/migrate` exports `defineConfig`, `MigrateConfig`, and `TargetInput`. The CLI imports the planning and apply helpers from the package. Those helpers are not exports.

`okmodel/testing` is reserved for 0.4 (P54) and is not in the exports map.
