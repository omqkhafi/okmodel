# Types spike findings

Question: do row types stay fast and readable at 10, 50, 200, and 500 tables, and should the default be types inferred from `table()` or types emitted by a build step?

Compiler: TypeScript 7.0.2 (`tsc --extendedDiagnostics`). Fixtures are the P02 generator, seed 1, tenancy `none`. Instantiations and Types are the primary numbers. Check time is one run and is secondary. Hover text is not measured: TypeScript 7.0 has no compiler API (D111), so the proxy is `tsc` error text and declaration text. Both are in `snapshots/`.

The projects use the repository's strict flags and `skipLibCheck: true`, matching `tests/fixtures/type-cost`. An empty project is the baseline (340 types, 0 instantiations).

## Recommendation

Emit row types. On the 200-table fixture the emitted project is faster on both primary counters: 0 instantiations and 559 types, against 53,410 instantiations and 8,390 types for inference. Check time is 0.001s against 0.023s. Memory is 27,900K against 36,205K.

Inference stays linear through 500 tables (about 250 instantiations and 31 types per extra table, 0.083s check). It is usable. It is still the slower strategy at every size, and its error text and declaration emit print the builder encoding rather than the row.

The shape that matches the numbers: authors keep `table()` / `schema()`, and the build step writes interfaces in the style of `.okm/types.d.ts`. App code reads those interfaces. Checking the schema file still pays the inferred cost when that file is part of the program.

No product ceiling is set here. The 200-table inferred run is the evidence a later gate would budget against if inference stayed the default: 53,410 instantiations, 8,390 types.

## What worked

- `table()` / `schema()` infer row, insert, and update. Hidden columns drop off the row. Generated, guarded, and id columns drop off insert and update. Nullable columns and defaults are optional on insert. Picklists and enums are literal unions. JSON and arrays keep their element type. `t.id()` brands the primary key.
- `tableShapes`, `Crud`, `ArchiveCrud`, `TablesWith`, and `TablesWithColumn` typecheck with no casts. `expect-type` covers them in `shapes.test-d.ts`.
- `citext()` is a `defineColumn<Citext>()` in an extension file. `column.ts` does not mention citext. Ten extension brands on the 200-table fixture add 10,211 instantiations (53,410 to 63,621) and 453 types. Same order of magnitude. The extension contract does not need to be simplified for this cost.
- `Register.schema` defaults `Row<"tasks">`. A second file may repeat that same type. Two files that add `RegisteredTables` properties merge, and each table file avoids importing the other. A name reference (`t.uuid().references("users")`) resolves inside `schema()`.
- A value-import cycle between two table files still typechecks. `typeof b["~name"]` stays `"b"` (`snapshots/import-cycle.txt` is the probe `1` not assignable to `"b"`, which shows the literal survived).
- Two `Register.schema` augmentations with different types fail with TS2717 (`snapshots/register-conflict.txt`).
- The build step's declaration for the first seed-1 table names `Insert_t000` and the fields (`snapshots/emitted-row.txt`). An empty insert then fails as `Type '{}' is missing the following properties from type 'Insert_t000'` (`snapshots/emitted-insert-missing.txt`).
- Recursive duplicate detection (`DuplicateNames`) still compiles at 500 names.

## What broke

- Inferred errors print `ColumnBuilder` and the flag object. `Row<"missing">` fails as a constraint on `TableName<Schema<...ColumnBuilder...>>`, truncated by `tsc` (`snapshots/unknown-table.txt`). A missing column is reported, but only after that dump (`snapshots/insert-missing.txt`).
- `tsc --declaration` does not expand the row. `display-subject.d.ts` keeps `export type TaskRow = typeof tasks["~row"]` and prints the builder on the const (`snapshots/declaration.txt`). That is not hover text.
- Duplicate table names do not fail the `schema()` call. The name map turns them into a union of the two row types (`snapshots/duplicate-name.txt`). A missing reference does fail, and the required property is `{ "~missing": "nope" }`, buried under the same builder dump (`snapshots/missing-ref.txt`).
- `DuplicateNames` on 500 strings costs 262,107 instantiations, more than inferring the whole 500-table fixture (126,532). It is the wrong check to put on `schema()`.

## Classification

| Item                                                | Class              | Evidence                                                                                                                                                                            |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inferred error text is the builder, not the row     | DX                 | `unknown-table.txt` constrains on `ColumnBuilder` and truncates. `emitted-insert-missing.txt` names `Insert_t000`.                                                                  |
| Declaration emit does not expand `~row`             | DX                 | `declaration.txt` is `typeof tasks["~row"]` plus flag objects. Hover was not measured; this is the proxy.                                                                           |
| Duplicate names become a union                      | missing capability | Spec OKM1023. `schema({ tables: [same, same] })` typechecks. The row is `Row<name> \| Row<title>`. `duplicate-name.txt`.                                                            |
| Recursive uniqueness does not scale onto `schema()` | performance        | 500 names: 262,107 instantiations. The 500-table inferred schema is 126,532.                                                                                                        |
| Unknown reference is a giant assignability error    | DX                 | The missing name is present (`"~missing": "nope"`) and the rest is the builder. `missing-ref.txt`.                                                                                  |
| Branded ids add type weight                         | performance        | D29 removed them for this reason. Inferred 200-table: 53,410 instantiations branded, 43,676 unbranded. Emitted consumer check does not move (559 types either way, `skipLibCheck`). |

No correctness bug turned up in the row, insert, and update rules that `shapes.test-d.ts` locks. Register merging, conflicts, and name references behave as TypeScript describes them. Nothing in the spec contradicts those results except OKM1023, which this inference does not implement.

## Measurements

Seed 1. Types and instantiations are stable across runs. Check time and memory are one run on this machine. `empty-libcheck` turns `skipLibCheck` off so the standard library is checked; subtract it from `emitted-200-libcheck` before reading that row.

| Project                            | Instantiations |  Types | Check (s) | Memory (K) |
| ---------------------------------- | -------------: | -----: | --------: | ---------: |
| empty                              |              0 |    340 |         0 |     24,912 |
| empty, lib checked                 |         28,457 | 32,828 |     0.109 |     62,309 |
| inferred 10                        |          5,438 |  2,388 |     0.004 |     27,437 |
| emitted 10                         |              0 |    369 |         0 |     25,177 |
| inferred 50                        |         15,318 |  3,634 |     0.005 |     29,220 |
| emitted 50                         |              0 |    409 |         0 |     25,800 |
| inferred 200                       |         53,410 |  8,390 |     0.023 |     36,205 |
| emitted 200                        |              0 |    559 |     0.001 |     27,900 |
| inferred 500                       |        126,532 | 17,654 |     0.083 |     49,950 |
| emitted 500                        |              0 |    859 |     0.001 |     32,124 |
| inferred 200, 10 extension columns |         63,621 |  8,843 |     0.025 |     36,987 |
| inferred 200, ids not branded      |         43,676 |  7,172 |     0.017 |     33,878 |
| emitted 200, ids not branded       |              0 |    559 |     0.001 |     28,057 |
| emitted 200, lib checked           |         29,057 | 34,859 |     0.102 |     66,382 |
| inferred 200, `Register` lookup    |         55,067 |  8,622 |     0.024 |     36,399 |

Instantiations from 50 to 200 to 500 grow by about 250 per table. Types grow by about 31 per table. Emitted types grow by about 1 per table (369, 409, 559, 859). Checking the 200-table `.d.ts` itself, after subtracting the lib-checked empty project, is about 600 instantiations and 2,031 types. The 0 in the emitted rows is the app check under `skipLibCheck`, which is how a generated `.d.ts` is consumed.

`Register` on the 200-table schema adds 1,657 instantiations. It is not the cost.

`DuplicateNames` instantiations: 40 names 4,047; 50 names 5,157; 80 names 9,687; 100 names 13,707; 200 names 45,807; 500 names 262,107. All compiled.

## Decisions made in the spike

- Primary keys in the scale fixtures use `t.id()` so the measured types include the brand from the generics suite. The unbranded 200-table row is the comparison. D29 already dropped branded ids; the delta is the weight that decision named.
- `timestamptz` is `string` here. The spec's default codec is Temporal. This spike does not implement codecs.
- `bigint` and `numeric` are `string`, matching the spec's default codecs. `jsonb` is an open object type.
- Per-file registration is a merged interface (`RegisteredTables`). `Register["schema"]` is one property. Nested object types do not merge, so two files cannot each assign a different `tables` object.
- Duplicate rejection is not inside `schema()`. The recursive checker exists so its cost is visible, and it is not on the measured path.
- Snapshot projects and the measured projects are written outside the repository so a failing `tsc` is not part of `bun run typecheck`.
