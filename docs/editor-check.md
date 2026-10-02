# Editor check

`bun run editor-check` drives the TypeScript 6 language server over stdio. TypeScript 7 ships `tsc` and no `tsserver`, so the server is the dev-only `typescript-editor` package. The script does not import it, and it is not part of a bundle.

The fixture is `tests/fixtures/editor/surface.ts`. Markers name a hover binding, a completion site, or a diagnostic. The check compares hover text, completion names, and diagnostic text with `tests/fixtures/editor/surface.snap.txt`.

It covers the read surface and the write surface:

- Completions in `where`, `insert`, and `update` `set` include the column names. Inside `insert({ ... })`, optional columns are optional keys, so the list includes the property under the cursor and every insertable column that is not already written. Guarded and omitted columns stay out. A required key for an optional column made that list a single property (D139).
- Hover on a `find` result and an `insert` result shows the row fields (`id`, `email`, and the value types), not a column builder.
- A missing `select` column and a missing table each produce a diagnostic that names `missing`.

`bun run editor-check --write` replaces the snapshot after a review. The check is part of `bun run check`.
