# Check a history in CI

`okm migrate check` proves a migration history is sound. It is a CI command: no prompts, and the result does not depend on colour. Exit zero prints one line, `ok N migrations`. Any failure exits non-zero. One failure prints its code, the message, and the fix. Several failures print one greppable line per failure.

The command writes a scratch schema, so point it at a throwaway Postgres. A protected target is refused. `--allow-protected` does not apply.

## What it checks

1. **History.** Every migration is applied, in order, into a scratch schema through the same path as `okm migrate apply`. The schema name starts with `okm_check_` and is dropped at the end, including after a failure. After each migration the scratch schema is introspected and planned back to that file's catalog. A remaining step is OKM1547 and names the migration and the steps. Two migrations generated from the same parent fail here: `migration X was generated from a different parent than Y`.
2. **Previous catalog.** For migration N, catalog N−1 is the previous release. Every table, column, constraint, and type in N−1 must still exist in N with the same type, and nullability must not be tightened without a default. A gap is allowed only when the recomputed class is `contract`. The class comes from the SQL steps' kinds, or from planning N−1 to N again when a step has no kind. A hand-edited `-- class:` line is not trusted. A gap in an expand migration is OKM1548. This is schema-level. It does not prove application behaviour.
3. **Head.** The last migration's catalog must equal the current schema. Otherwise the command fails with OKM1549 and the fix is to run `okm generate`.
4. **Lint.** The whole history is linted. An error fails. An override with a reason is respected. Apply is unchanged: it still lints only migrations that are pending on the target.

`defineConfig({ lintFrom: "<migration id>" })` is the adoption baseline. Files before that id are not linted by `okm migrate check`. The id itself is linted. Use it when older migrations have unreasoned drops and the linter is being turned on now.

## `--provision`

`okm migrate check --provision` also installs the head snapshot into a second scratch schema and compares it with the replay. Both schemas start with `okm_check_` and are dropped at the end, including after a failure. Type names are normalised before the comparison. A difference is OKM1521 and names the object. The default command does not do this. A protected target is still refused, and `--allow-protected` does not apply. See [provisioning](provisioning.md).

Tenant targets and schema-per-tenant checking are M5. See [known limits](known-limits.md#migrations).

## GitHub Actions

The job starts Postgres, then runs the check. The URL belongs to that service. Do not point this command at a protected database.

```yaml
name: migrate
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx okm migrate check
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

`okmodel.config.ts` reads `DATABASE_URL` for that target, and the target is not `protected`.
