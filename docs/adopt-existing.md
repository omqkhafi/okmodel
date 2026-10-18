# Adopt an existing database

A live database with no OKModel history can be adopted without replaying DDL (D299).

## Steps

1. Point `okmodel.config.ts` at the database.
2. Introspect with `okm pull` (or write the schema by hand so it matches).
3. `okm generate init` so the project has a head snapshot.
4. `okm migrate baseline` to record that snapshot as applied history.
5. Later changes use `okm generate` and `okm migrate apply` as usual.

```sh
bunx okm pull
bunx okm generate init
bunx okm migrate baseline
bunx okm generate
```

After a successful baseline, `okm generate` prints `no changes` when the schema still matches the head, and `okm migrate check` passes.

## What baseline does

It introspects the target and compares managed objects with the head catalog. On a match it writes `okm_meta` and one `okm_history` row, `baselined@<migration id>`, with the head catalog hash. It does not create, alter, or drop user objects. It does not insert `reference` rows.

Objects present in the database and absent from the model (other tables, triggers, extensions, functions, and the same kinds) are listed as unmanaged. They are left alone. `--json` includes that list.

## Refusals

| Situation | Code |
| --- | --- |
| Live database differs from the model on managed objects | OKM1858 (prints the plan that would reconcile them) |
| Target already has OKModel history that is not this baseline mark | OKM1857 |
| Protected target without `--allow-protected` | OKM1850 |

`--dry-run` prints what would be recorded and writes nothing. Running baseline again on the same mark and hash prints `already baselined` and changes nothing.

## Programmatic entry

`baseline(target)` from `okmodel/migrate` uses the same rules. `default` is the `database` target. A protected target still needs the CLI flag `--allow-protected`; the function does not take that override.
