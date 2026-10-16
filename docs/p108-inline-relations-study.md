# P108: inline relations redesign study

Report only. Measured on `7235a01` (the `main` tip this branch started from). No gate, ceiling, or dependency moves. Probe patches were discarded. Nothing under `src/` is in this change.

The question is whether `as` / `has` on a relation can ship in 0.8 without raising an existing ceiling. P101 measured the default-on shape at +30,751 query instantiations. This study did not repeat that patch. It measured four other shapes against the same fixtures.

Any new ceiling for a new fixture is Ali's decision. This study does not add one.

## What the ceilings instantiate

`bunx tsc --generateTrace` on each fixture. The trace's type-id count matches the `Types` diagnostic (query-200 is 6,377 ids and 6,377 types). The instantiation counter is separate (query-200 is 17,252) and is what the instantiation ceilings gate. The trace does not split that counter by alias. Counts below are type identities whose symbol is declared in `dist/` or, for the operator surcharge, in `packages/spikes`.

The query fixtures are `writeQueryProject` in `scripts/type-projects.ts`: 200 harness tables, plus `owner` and `note`. `note.ownerId` calls `.references("owner")`. The 200-table file contains 77 `.references()` calls. The composite fixture adds `tag` and `noteTag` and contains 79.

### query-200 (17,252 instantiations, 6,377 types)

Identities by declaration file: `table.d.ts` 598, `runtime/types.d.ts` 392, `column.d.ts` 285, `schema.d.ts` 73, `operators.d.ts` 63, `relations.d.ts` 38, `where.d.ts` 30, then the column builders the fixture calls (`integer`, `decimal`, `range`, `keys`, `json`, `bool`, `text`, `time`).

Named identities that carry the schema and the one query:

| Symbol | Ids | Where |
| --- | ---: | --- |
| `Table` | 412 | `table.d.ts` |
| `ColumnBuilder` | 77 | `column.d.ts` (one per `.references()` call) |
| `ManyRelation`, `OneRelation` | 12 each | `relations.d.ts` |
| `RelationsOf` (table) | 6 | `table.d.ts` |
| `DeclaredTable`, `RowFrom` | 4 each | `table.d.ts` |
| `BuiltSchema`, `TenancySchema` | 6 and 4 | `schema.d.ts` |
| `RowOf` | 10 | `runtime/types.d.ts` |
| `RelationKeys`, `FieldWhere`, `Eq` | 7 each | `types.d.ts`, `where.d.ts`, `operators.d.ts` |
| `WhereOf`, `FiltersOf`, `TableExtras` | 5, 6, 6 | `runtime/types.d.ts` |
| `IncludeOf`, `IncludeRows`, `Selected`, `Read` | 4 each | `runtime/types.d.ts` |
| `TableApi`, `PresetApi`, `TxApi` | 3 each | `runtime/types.d.ts` |

`IncludeOf` is 4 identities, not one per table. The 200 tables pay for `table()` / `schema()` (`Table`, `ColumnBuilder`, `RowFrom`, `ColumnRowOf`). The query types pay when `probe.ts` calls `find`, `insert`, `update`, and `delete` on `note`. Headroom on this row is 48 instantiations (17,300) and 723 types (7,100).

### What each other fixture adds

Deltas are identities above query-200.

| Fixture | Ceiling (inst / types) | Measured | Added identities |
| --- | --- | --- | --- |
| query-200+extensions | 17,300 / 7,100 | 17,286 / 6,497 | `extension` and `Extension` (2 each). Twelve `extension()` calls. 14 instantiations left |
| query-200+page+aggregate+through | 24,792 / 6,931 | 24,449 / 6,931 | `RelationFilter` +9, `ManyThroughRelation` +6, `Page` and `PageOptions` +4, `AggregateOptions` +2, `has` +1, `Bucket` +2. 343 instantiations left. 0 types left |
| query-200-validate | 25,631 / 6,604 | 25,221 / 6,569 | `TableExtras` augmented from `okmodel/validate`: `ValidateInsert`, `ValidateUpdate`, `InputBody`, `Marked`, `TableOption`. 410 instantiations and 35 types left |
| query-200+presets | 19,755 / 7,341 | 19,367 / 7,256 | `PresetMap`, `Preset`, `PresetQuery`, `InList`. The preset closures also rebuild column and operator identities (`ColumnBuilder` +33). 388 instantiations and 85 types left |
| query-200+tx | 25,011 / 7,156 | 24,457 / 7,052 | `TxClient` +13, `TxApi` +11, `TableApi` +17, `TxNames` +20, `LockOptions`, `TxOptions`, `afterCommit`. 554 instantiations and 104 types left |
| columns | 720 / 1,100 | 624 / 918 | The column sample only. `ColumnBuilder` 76, `ColumnRowOf` / `ColumnInsertOf` / `ColumnUpdateOf`, and one identity per scalar builder (`enumColumn`, `domain`, ranges, network, geometry). No `references()` call. 96 instantiations and 182 types left |
| tagged-operator surcharge | 800 instantiations | 639 | Source fixtures in `packages/spikes`, not okmodel. `EqWhere` is 24 instantiations. `Where` / `TaggedOperator` is 663. The surcharge is 663 − 24. 161 left |

The featureless app is bytes, not these types: 90,866 minified / 29,465 gzip, gate 90,900 / 30,170 (34 minified bytes left). The runtime entry is `src/contracts/index.ts`: 5,288 / 2,026, cold import 3.735 ms on this machine, gate 6,100 / 2,250. No candidate edited that file, so the entry was measured once.

Within 3 percent of a ceiling on this sample: query-200 instantiations (48), extensions instantiations (14), composite types (0), and validate types (35).

## Candidates

Each row is one discarded patch. "Existing" means the fixtures above. "Feature fixture" is the 200-table query project actually calling the new API. That fixture has no ceiling.

| Candidate | Existing ceilings | Feature fixture | Verdict |
| --- | --- | --- | --- |
| A. Opt-in entry `okmodel/pg/relations` | Every row identical to the sample, including the app at 90,866 / 29,465 | 54,012 inst / 7,961 types | Fits every existing ceiling |
| B. Lazy harvest inside `table()` | query-200 17,450 / 6,447 (150 inst over). Extensions 17,484 / 6,567 (184 inst over). Composite 24,647 / 7,001 (70 types over 6,931). Validate 25,419 / 6,639 (35 types over 6,604). Presets 19,565 / 7,325 (fits; 16 types left). Tx 24,655 / 7,122 (fits; 34 types left). Columns 624 / 918. Surcharge 639. App minified 90,866, gzip 29,471 | 56,066 / 8,128 | Misses four ceilings |
| C. Narrow `asRelation` on the `okmodel/pg` barrel, one level, no `has` | Every type row identical. App minified 90,866, gzip 29,466 | 27,690 / 7,092 | Fits every existing ceiling |
| D. `as?: string` and `has?: string` stored by `references()`, literals dropped | Every type row identical when the calls omit the new fields. Columns 624 / 918. Surcharge 639. App 90,932 / 29,488 (32 minified over 90,900) | 17,252 / 6,546 when all 77 calls pass `{ as, has }` | Misses the app gate |

A checked empty-name helper on D measured 91,060 / 29,514 (160 minified over). The table uses the smaller store, which still misses.

### A. Opt-in entry

`relates` and `inlineRows` live in a module the fixtures do not import. `references()`, `DeclaredTable`, and `IncludeOf` stay as they are. `as` is the to-one name on the declaring table. `has` is the reverse to-many, recovered by one union of every column rather than a generic method on `ColumnBuilder`. The include is one level.

```ts
import { relates, inlineRows } from "okmodel/pg/relations";

const posts = table("posts", {
  authorId: relates(t.uuid(), "users", { as: "author", has: "posts" }),
});

inlineRows(app, "posts", "author", { select: ["email"] });
```

The feature fixture keeps the query-200 `find` / `insert` / `update` / `delete` and adds `author` plus the reverse name `written`. 54,012 − 17,252 = 36,760 instantiations, and 7,961 − 6,377 = 1,584 types, all on that fixture.

### B. Lazy harvest on the default table type

`table()` grows a mapped type over its columns. Columns with no `~inline` phantom take the `false` branch and keep today's `relations` option. The scan still runs for every table that passes options. That is +198 instantiations and +70 types on query-200 before any call site uses the feature. Query-200 has 48 instantiations of room, and the composite probe has 0 types of room, so the idle scan is already over both.

When a column does carry the phantom, the harvested `{ kind: "one", table, field: undefined }` is a `RelationCall`, and `find({ include: { author } })` typechecks. The feature fixture that does so measures 56,066 / 8,128.

```ts
import { relates } from "okmodel/pg/relations";

const posts = table("posts", {
  authorId: relates(t.uuid(), "users", { as: "author" }),
});

db.posts.find({ include: { author: { select: ["email"] } }, limit: 2 });
```

Presets on this patch sit 16 types under 7,341, and tx sits 34 types under 7,156. Both are inside 3 percent of the ceiling.

### C. Narrow name, one level, no overload

`asRelation(column, table, name)` is a free function re-exported from `okmodel/pg`. It is not an overload of `references()`. `inlineOne` reads names on that table only. There is no reverse `has`. Importing the barrel without calling the function left every type fixture on the sample.

```ts
import { asRelation, inlineOne } from "okmodel/pg";

const posts = table("posts", {
  authorId: asRelation(t.uuid(), "users", "author"),
});

inlineOne(app, "posts", "author", { select: ["email"] });
```

The feature fixture measures 27,690 / 7,092 (+10,438 instantiations and +715 types over query-200).

### D. Runtime strings, loose type

`references(table, { as, has })` stores both strings on the column. The parameter types are `string`, so the literal is gone and `include` does not gain the name. Schema compilation was left unchanged, so this probe does not register a relation and does not touch the catalog hash. A later registration in `schema()` would add more bytes on top of a number that is already over the app gate.

```ts
const posts = table("posts", {
  authorId: t.uuid().references("users", { as: "author", has: "posts" }),
});

// include still knows only relations written in the relations option
db.posts.find({ include: { owner: true }, limit: 2 });
```

Passing `{ as, has }` on all 77 calls kept instantiations at 17,252 and raised types from 6,377 to 6,546, still under 7,100. The app gate is the miss: 90,932 minified, 32 over 90,900. Gzip 29,488 is under 30,170.

## Recommendation

Rejected. See [Addendum: P108 close-out](#addendum-p108-close-out). The text below is the recommendation as measured.

Ship the opt-in entry (A) if 0.8 is allowed to type `as` and `has` only for programs that import `okmodel/pg/relations`. It is the only probed shape that types both names and leaves every existing ceiling on the sample. It is not the default-on direction from the relations design. Default-on still does not fit: B is the closest default-path attempt, and it is 150 query instantiations and 70 composite types over. D is the closest on types (+0 until the options are passed) and misses the app by 32 minified bytes, without typing the names.

C also fits, and its feature fixture is the smaller one (27,690 / 7,092). It drops `has`.

### Implementation outline for A

Stop at the first miss. Do not raise a ceiling in the same change.

1. Add `okmodel/pg/relations` as its own entry. Do not edit `ColumnBuilder.references`, `DeclaredTable`, or `IncludeOf`. Stop if query-200 exceeds 17,300 instantiations or 7,100 types, extensions exceeds 17,300 / 7,100, composite exceeds 24,792 / 6,931, validate exceeds 25,631 / 6,604, presets exceed 19,755 / 7,341, tx exceeds 25,011 / 7,156, columns exceed 720 / 1,100, or the tagged-operator surcharge exceeds 800. On this sample the extensions row has 14 instantiations left and the composite row has 0 types left.
2. Keep that module out of the featureless app and out of `src/contracts/index.ts`. Stop if the app exceeds 90,900 minified or 30,170 gzip, or the runtime entry exceeds 6,100 / 2,250. This sample's app has 34 minified bytes left, so the entry cannot be imported from `scripts/app-startup.ts`.
3. Implement `relates` and one-level `as` / `has` in that module. The feature fixture on the 200-table query project measured 54,012 instantiations and 7,961 types. Stop and ask before exceeding that sample. There is no ceiling to compare it with until Ali sets one.
4. Register the names at runtime inside that module. Do not write them into the catalog document. Stop if step 2's byte gates move.

## Addendum: P108 close-out

Ali rejected the opt-in entry. The only acceptable call was `find({ include: { author } })` with no codegen. `relates` and `inlineRows` are not that call.

P108B then probed that call. E1 (type augmentation) and E2 (harvest when `find` resolves a table) both moved an existing ceiling. Candidate D had already missed the app gate by 32 minified bytes. Nothing shipped. [D270](okmodel-decisions.md) records the numbers and the reopen conditions. `relations` on the table remains how an include is named.
