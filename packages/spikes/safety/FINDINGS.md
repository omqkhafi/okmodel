# Safety spike findings

Question: what do tagged operators cost, at runtime and in the type checker, and can a final safety pass guarantee the spec over every combination of presets, traits, and filters?

Compiler: TypeScript 7.0.2 (`tsc --extendedDiagnostics`). Fixtures are the P02 generator, seed 1, tenancy `none`. Instantiations and Types are the primary numbers. The equality project imports only an equality filter type. The tagged project imports the operator module. Both probes index every column (`Apply`), because a mapped `Where<T>` that nothing reads is not instantiated. Runtime figures are one run on this machine, in microseconds, mean and p99. They are not locked. `bun run spikes:update` rewrites the type-cost locks, including the P04 file.

## Recommendation

Ship tagged operators. On the 200-table fixture they add a constant 639 instantiations and 549 types over an equality filter (663 vs 24 instantiations, 1,421 vs 872 types). The same 663 instantiations appear at 10, 50, and 200 tables. On top of inferred `table()` rows the delta is 641 instantiations and 490 types (98,487 vs 97,846). Check time does not move (0.030s either way).

The final safety pass can guarantee the rules it is given, if contributions are additive and provenance is stamped by the pipeline. Random combinations of presets, traits, and filters did not bypass tenant isolation, archive visibility, hidden fields, sensitive redaction, or guarded inputs. Shuffling rule order did not change the verdict or the SQL. A recorded rule could not disappear without OKM1190 `dropped`.

It cannot guarantee what the spec does not pin down. A preset written as `(q) => q.where(...)` can erase caller filters if `where` replaces, and safety still passes, because caller filters are not invariants. A plain object cannot be both "equality" and "always rejected" for a jsonb column.

## What worked

- Helpers stamp a unique symbol. `JSON.parse(JSON.stringify(lt(1)))` is not an operator. A plain object or array in a value slot throws OKM1121. Spread inside the same realm keeps the symbol; that is the same as calling the helper.
- Quoting is injective for every accepted string, including reserved words, non-ASCII, and embedded quotes. A 63-byte name passes. 64 bytes fails. NULs, C0 controls, bidi overrides, zero-width characters, and noncharacters fail. Fuzzing did not find a quote breakout. A Cyrillic lookalike of `tenantId` is an unknown field (OKM1120), not the catalog column.
- `plan` accepts only a query `verify` branded. A cast without the symbol throws.
- Attacks that fail closed: deleting the tenant predicate, OR-wrapping it, relabeling it as a caller filter, a guarded field in the input, the tenant key in insert or update input (even with `allow`), a hidden field in the default projection, clearing the redact list, a blank `unscoped` / `all` / `trusted`, a parameter that is not a `$name` slot.
- `unscoped("nightly report")` and `trusted("hand sql")` omit the structural tenant check and are recorded on the plan. `trusted` also omits the archive check. `.all("export")` omits the read bound. `allow: ["role"]` permits that guarded field.
- A relation filter on `list.name` adds `lists` to the tables touched and requires its tenant predicate. The client value is a parameter. It does not appear in the SQL text.
- Hidden fields cannot be allowlisted. An operator outside the allowlist throws OKM1121. An unknown field throws OKM1120.
- Eighty random drafts (seed 1), each checked again with contributions and AND/OR children reversed, kept the same verdict. Every accepted draft still had its tenant predicate, archive predicate, hidden default, sensitive redaction, and guarded-input rule.

## What broke

- Naming `Where<Table>` without indexing its keys does not instantiate the operator union. The first probe reported 654 instantiations at 10, 50, and 200 tables, identical to a probe that imported both types. The numbers below force the index.
- `withArchived` removes the archive predicate. The column can still appear in the select list. A check for the text `archivedAt` is not a check for the predicate.
- An insert draft that lists another tenant table under `touched` has no tenant value for that table, so verification fails closed. The spike does not model a multi-table write.
- Sensitive redaction is by column name. Two tables with the same sensitive name share one entry.

## Classification

| Item                                                        | Class              | Evidence                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plain value means equality, and a plain object is OKM1121 | contradiction      | Spec 10.1. jsonb equality is an object. This spike rejects every bare object, so an object column has no equality form. The operator list has no `eq()` helper.                                                                               |
| `where` does not say whether it appends or replaces         | DX                 | A find with only `pending()` verifies and plans. The caller filter was never recorded, so it is absent, and the tenant predicate is present. A recorded caller filter that is then removed throws OKM1190 `dropped`.                          |
| OKM1190 names "the rule" when several rules fail            | DX                 | A query can break guarded, hidden, and dropped together. The spec names one rule and one contribution. This spike returns every violation, sorted, so check order cannot change the set. The error's `rule` is the first of that stable list. |
| Structural identifier rejection has no OKM code             | missing capability | OKM1120 is "unknown field". Length, NUL, controls, and unquoted reserved words use that code with rule `identifier`.                                                                                                                          |
| A hidden allowlist has no OKM code                          | missing capability | The spec forbids it and does not name a code. This spike uses OKM1190 `hidden`.                                                                                                                                                               |
| Tagged operators are a fixed type cost                      | performance        | +639 instantiations and +549 types at 200 tables, and the same 663 instantiations at 10 and 50. Inferred rows: +641 instantiations, +490 types.                                                                                               |
| Verification is linear in predicates and tables             | performance        | 1 predicate mean 4.6 µs; 128 predicates mean 232 µs, p99 523 µs. 40 tables mean 220 µs, p99 255 µs.                                                                                                                                           |
| The checker is structural, not a SQL prover                 | missing capability | `AND` holds if any child holds. `OR` holds only if every child holds. `NOT (tenant_id <> $tenant)` is not representable. Unverifiable SQL is the `trusted` hatch, matching OKM1702.                                                           |
| Cascade, to-many bounds, and capabilities are not checked   | missing capability | Spec 5.2 lists them. This spike checks tenant, archive mode, guarded input, hidden default projection, sensitive redaction, read bounds, write filters, and parameters.                                                                       |

No accepted random draft bypassed a rule the verifier implements. The property test is `safety.property.test.ts`.

## Measurements

Seed 1. TypeScript 7.0.2. Instantiations and types are the locked counters. Check time is one run.

The inferred rows include the P04 `table()` project plus a filter applied to every row. They are not the P04 inferred-200 figure (53,410 instantiations, 8,390 types). Compare the two inferred rows to each other.

| Project               | Instantiations |  Types | Check (s) |
| --------------------- | -------------: | -----: | --------: |
| empty                 |              0 |    340 |     0.001 |
| equality 200          |             24 |    872 |     0.001 |
| tagged 10             |            663 |    972 |     0.003 |
| tagged 50             |            663 |  1,062 |     0.001 |
| tagged 200            |            663 |  1,421 |     0.001 |
| inferred equality 200 |         97,846 | 10,291 |     0.030 |
| inferred tagged 200   |         98,487 | 10,781 |     0.030 |

Tagged minus equality at 200 tables: 639 instantiations, 549 types. Tagged instantiations do not grow from 10 to 200. Inferred tagged minus inferred equality: 641 instantiations, 490 types.

Runtime, one run, microseconds per call. Mean and p99. Not locked. Small queries have a noisy p99 because one slow sample dominates 100.

| Sample                 | Mean (µs) | p99 (µs) |
| ---------------------- | --------: | -------: |
| one tagged operator    |     0.008 |    0.048 |
| one plain value        |     0.003 |    0.008 |
| 8 tagged operators     |     0.106 |    1.289 |
| 8 plain values         |     0.032 |    0.086 |
| quote a short name     |     0.077 |    0.591 |
| quote a 63-byte name   |     0.280 |    0.755 |
| quote `タスク`         |     0.078 |    0.099 |
| known-field check      |     0.050 |    0.143 |
| verify, 1 predicate    |     4.640 |   31.558 |
| verify, 8 predicates   |     8.208 |   31.404 |
| verify, 32 predicates  |    29.191 |   50.852 |
| verify, 128 predicates |   231.722 |  523.346 |
| verify, 1 table        |     3.970 |   61.425 |
| verify, 10 tables      |    28.230 |   69.042 |
| verify, 40 tables      |   219.518 |  254.790 |

Building eight tagged operators is about 0.07 µs above eight plain values. Quoting stays under 1 µs at p99 in this run. Verification grows roughly with the number of predicates and the number of tables touched.

## Decisions made in the spike

- Provenance is stamped by the pipeline. A preset is a list of predicates, not a function that receives the query. The spec writes presets as `(q) => q.where(...)`. The function form can replace `where` before anything is recorded. That gap is the DX row above.
- `allow` does not let input set the tenant key. Inserts write it from `$tenant`. Updates that include it fail. The spec says `allow` opens guarded fields and that inserts fill the tenant key from context. It does not say `allow` can override the key. This spike fails closed.
- `trusted` skips the tenant and archive structural checks only. Guarded, hidden, sensitive, bounds, and parameters still run. That matches OKM1702 (unverifiable SQL), not a hatch that skips every rule.
- Blank reasons do not count as hatches. The tenant predicate is still added, and the blank reason is itself a violation.
- Runtime identifier checks reject a name over 63 bytes. They do not hash-suffix it. The catalog spike suffixes stored names so two long names stay distinct. A suffix here would name a different column than the one the caller asked for. Both limits are 63 bytes.
- Reserved words are quoted on emit. `assertUnquotedIdentifier` exists so a forgotten quote fails in tests. Production SQL uses `quoteIdentifier` only.
- Dots inside `quoteIdentifier` are one name. `quoteQualified` splits on dots.
- Client filters accept `in` as well as `inList`. The spec's allowlist spells `in`.
- Multiple violations are sorted. The thrown error uses the first code in that order. OKM1101 and OKM1102 are used for the read bound and the write filter. Other verifier failures are OKM1190.
- `fast-check` is a devDependency of `packages/spikes` only.
