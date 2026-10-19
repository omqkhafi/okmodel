# Changelog

Release history for `okmodel`. One section per published tag, in reverse order.
This file is the canonical source.

Upcoming work lives under `## Unreleased`. `bun run bump next` moves
`package.json` to `<next release>-next.N` and leaves this section in place.
`bun run bump release` drops the suffix and promotes the section into
`## v<version> — <YYYY-MM-DD>`. Every bullet belongs to an
`### ✨ Added` / `### 💥 Breaking Changes` / `### ♻️ Changed` / `### 🐛 Fixed`
group (also `### ⚠️ Deprecated` · `### 🔥 Removed` · `### 🔒 Security` when
needed). Large groups add `####` area headings (`contracts`, `dialects`,
`adapters`, `runtime`, `tooling`, `docs`) so the list stays scannable.

## Unreleased

### behaviour changes

- With `validation: true`, an unknown key on `insert`, `update`, upsert / `onConflict`, or first-or-create is OKM1120 and names the key and the table (R1, D304). A typo-only `update` names the key instead of saying "update set is empty."
- `okm generate` exits 1 when an error finding exists; the migration file is still written; stderr says `okm migrate apply` will refuse until it is fixed (Q8, #395). A warning-only finding stays exit 0.

### ✨ Added

- Global `--config <path>` on every `okm` command that loads a config; default discovery stays `okmodel.config.ts`. A missing file names that path and `--config`.
- `plan`, `apply`, and `status` on `okmodel/migrate` share the CLI migrate engine for CI and deploy without shelling out (D298).
- `okm migrate baseline` and `baseline(target)` from `okmodel/migrate` record the head snapshot as applied history on an existing database without DDL (D299). A managed mismatch is OKM1858 with the reconcile plan; unmanaged objects are reported and left alone; existing history is OKM1857; a protected target needs `--allow-protected`.
- Docs: [Adopt an existing database](docs/adopt-existing.md) and the handbook page cover pull, generate, then baseline.
- `describe(schema)` on `okmodel/migrate` reports `minPostgres` and `extensions` (each with a reason). `okm doctor` and `okm check` refuse a server below that floor (OKM1802 / OKM1803) or missing a required extension (OKM1811) (D300).
- `bun run ci:report` prints job and step duration, queue time, the critical path, and re-run counts for recent `main` runs, and why each 0.9.1 pull failed a push.
- `bun run verify:fast` checks format, lint, types, layers, purity, docs, and the readme, then runs only the tests related to files changed since the merge-base with `origin/main`.
- `bun run ci:fail <pull>` prints the first failing job, its failing step, the last 60 log lines, and the one local command that reproduces it.

### ♻️ Changed

- `gate / check` always runs (`if: always()`), keys concurrency on the pull request number (or the commit on `main`), and requires the full tier for `full-ci`, a `chore(release)` title, a change under `.github/workflows`, or a push to `main`. A no-op label event mirrors the last gate result for that commit instead of reporting Success from a skipped job. Plan: [docs/ci-and-test-cycle-plan.md](docs/ci-and-test-cycle-plan.md).
- The drivers CI group is three shards (`drivers suite`, `drivers rest`, `drivers-conformance`). The pglite conformance report and the live compatibility table check sit on the conformance shard; the fast path keeps a cheap case-list sync. Driver and error suites open PGlite from a prepared data directory instead of running initdb on every pool.
- postgres.js kill-storm uncaught exceptions are documented as an upstream limit (B-02): a minimal postgres.js-only reproduction lives in `docs/postgresjs-kill-storm.md`, known-limits and the Drivers page recommend `okmodel/pg/pg` or `okmodel/pg/bun` where failover is expected, and the adapter's process listener is described as damage control rather than a fix.
- A pull request that only changes `docs/` or `site/` skips the runtime test matrix, Postgres, the type-cost step, and attest. `gate / check` stays the required status and counts that skip as a pass only when the filter says those jobs are irrelevant.
- CI builds `dist` once and uploads it. Jobs that need the build download it. Jobs that do not need it skip the build. Bun's install cache is on every install, and typecheck keeps a TypeScript incremental build.
- The topology CI group is two shards. Topology tests open PGlite from a prepared data directory instead of running initdb on every database.
- Tier 1 runs on every pull request push: format, lint, typecheck, the unit tests, property tests at a quarter of their count (`OKM_PROPERTY_SCALE`), and the size gate. Tier 2 (type cost, the editor check, attest, runtimes, the temporal matrix, package checks, Windows, Postgres 15 and 18, and the `drivers-conformance` group) runs with the `full-ci` label and on every push to `main`. A later commit on `main` does not cancel the run in progress. A failed `gate / check` on `main` opens an issue.
- Docs: `connect({ hookm })` is an array; a single observer object or a `hooks` key does not register observers.

### 🔥 Removed

- Deno is not a supported runtime. Portable checks run on Node and Bun, and the runtime entry is imported as an edge bundle on Node (D297).

### 🐛 Fixed

- `okm migrate check` and `okm check` reprint table checks (including picklists) on the connected server before planning, so an author `IN (...)` spelling is not permanent OKM1547 or a NOT VALID/VALIDATE swap against `pg_get_constraintdef` (R2, #399, D128). Check `columns` are left out of the plan comparison when an author check omits column handles.
- `okm check` checks the Postgres major before author drift and required extensions after it, so a pending migration that creates an extension still surfaces OKM1520 instead of OKM1811. An extension an applied or pending migration creates is not refused as a missing install; when the package is absent from the server, OKM1811 points at `okm migrate apply`. Several targets and no `--target` print `server checks skipped: N targets, pass --target <name>` from `okm doctor` and `okm check` (#400).
- The archivable unique-predicate migrate-check case tolerates `okm generate` exiting 1 on OKM1529 so the allow line can be written before apply (follow-up to Q8).
- Validated `insert` / `update` handles expose `~plan` again, so `batch()` and `isolation()` work with `validation: true`. A failing rule inside a batch rolls everything back and reports OKM1200 with `issues` and `batchIndex` (D302, Q1).
- The linter no longer refuses the planner's own `NOT VALID` then `VALIDATE` pair when the check is on a column added in the same migration with a constant default (or nullable without a default). A validate on an existing column, or after a volatile default, stays OKM1531 (D301).
- The expand/contract type-change drop recipe no longer puts `-- okm-allow OKM1512` on `DROP TRIGGER` (that code does not fire there and was OKM1510). The trigger needs no allow; the function keeps OKM1515 and the column keeps OKM1512, under a name header so the first statement is a step (B-36).
- `testing()` plain-populates materialized views after migrate, and `isolation()` falls back to a plain refresh when a concurrent refresh says the view is not populated, so `refresh: "concurrently"` works inside the harness (B-34).
- Composite tenancy factories generate a distinct uuid per key, honour an explicit full key, and refuse a partial one instead of copying one key onto another; `isolation()` flip inserts skip identity columns so `lists.id cannot be written` no longer fails (B-32).
- Documented that LIFO PgBouncer on a non-heuristic port can pass the pid probe: mark it with `?pgbouncer=true` (or a `pooler` / `pgbouncer` host). Apply does not warm-and-hold a second backend (B-41).
- The statement parameter ceiling is 65,533 so OKM1126 fires before postgres.js's `MAX_PARAMETERS_EXCEEDED` at 65,534 (B-48).
- A node-postgres call with `timeout` or `signal` removes its checkout `error` listener, so repeated timed calls do not stack listeners on a pooled client. A call that reaches its deadline while waiting for a connection is refused and does not run. A cancel that does not settle destroys that client, so the pool can serve the next call after a kill storm.
- After an external-table re-stamp, `okm migrate status` stays `current`, `generate` stays `no changes`, and `okm migrate check` no longer fails with OKM1549 when the only catalog drift is external columns (B-45).
- `okm migrate check` reprints domain checks before planning, so a non-canonical author check such as `VALUE > 0` is OKM1552 only and not permanent OKM1547 when `generate` says no changes (B-37).
- A trigger `WHEN` that names `OLD` and `NEW` no longer fails `okm check` / `okm migrate check` with "expression contains variables of more than one relation"; introspection reads the predicate from `pg_get_triggerdef`, and those columns are ordinary table dependencies (B-46).
- `defineConfig({ namespace })` places a trigger's called function with the catalog, so generate/apply/check no longer fail OKM1020 for a missing function in `public` (B-47).
- The guide roles flow on a fresh database no longer fails with `SAVEPOINT can only be used in transaction blocks` during provision: schema ownership runs without a savepoint when no transaction is open, `CREATEROLE` is checked on the connecting user (not the managed migration role), and a failed provision drops empty bootstrap tables so a retry is clean (B-30).

### 🔒 Security

- A postgres.js generic or aborted-connection failure on a statement whose table has a sensitive column no longer leaves `parameters` or `args` on `error.cause` when the driver omits `table` (B-33 residual, #364).

## v0.9.1 — 2026-10-17

### 💥 Breaking Changes

- Breaking-ish: now refused — a backslash in `fragment` / `raw` template text is OKM1125. Pass the value as an interpolation (B-01, D287).
- Breaking-ish: now refused — an unknown key on `insert`, `update`, upsert / `onConflict`, or first-or-create is OKM1120 and names the key and the table (B-39, D291).
- Breaking-ish: now refused — a finished statement with more than 65,535 parameters is OKM1126 (count and limit in the message) instead of a retryable `unavailable` (B-40, D292).
- Breaking-ish: now refused — an unknown CLI flag is an error; `okm <command> --help` lists that command's flags (B-26, D289).
- Breaking-ish: now refused — an `update` that would set a tree parent to the row itself or to a descendant is OKM1120 when `where` is the primary key (B-10, D295).

### 🔒 Security

- A backslash in a composed fragment can no longer desync the literal guard and escape a tenant filter (B-01, D287).
- A unique, foreign-key, or check failure on a table with a sensitive column no longer puts the value in `error.cause` (`detail`, parameters, `where`, and `internalQuery` stay off). Tables without sensitive columns keep today's cause. `includeValues` remains the explicit opt-in (B-33, D291).
- With `defineConfig({ roles })`, managed functions revoke `EXECUTE` from `PUBLIC` and grant it only to the app role, so the reporting role cannot execute them (B-31, D293). Provider-specific role checks (RDS, Cloud SQL, Supabase) follow in M-4.

### 🐛 Fixed

#### dialects

- `filters()` OKM1123 uses the calling table's own columns for allow/sort, and replaces per-table hidden marks when the same SQL name is redefined, so a prior `.hidden()` no longer poisons later suites that reuse `tasks.title` (and the same pattern for relation targets).

#### runtime

- A statement with more than 65,535 parameters fails with OKM1126 (count and limit in the message) instead of a retryable `unavailable`. The limit is for the whole statement, including filters and `inList` (B-40, D292). Split from the write-safety work on #339 when the combined change grew the featureless app by more than 100 B.
- An `update` that would set a tree parent to the row itself or to a descendant is OKM1120 when `where` is the primary key (B-10, D295).
- A throw from a custom `routing.select` keeps an `OkmError`'s kind; a plain throw becomes kind `invalid` instead of `driver` (B-35, D295).

#### adapters

- Bun.sql no longer parks a reserved handle for the next checkout, so concurrent scoped units after a backend kill keep separate sessions and tenant settings (B-03, D288).
- A reset or release failure after a statement or `COMMIT` completed destroys the connection and does not fail the call on Bun.sql, node-postgres, or Neon, so a committed write is reported as committed and `afterCommit` still runs (B-04, D288).
- node-postgres maps `Client has encountered a connection error and is not queryable` to a lost connection (`CONNECTION_CLOSED`), matching Bun.sql's message-only closed texts (D288).
- Bun.sql `reserve()` stamps code-less closed-socket texts (`Connection closed`, `connection must be a PostgresSQLConnection`) with SQLSTATE `08006`, so a checkout that fails before the reserved-handle guard classifies as `unavailable` instead of `driver` (B-03, D288).
- postgres.js caps reconnect backoff under 1 s with jitter, defaults `timeouts.acquire` to 10 s (OKM1846), swallows `nextWrite` on a null socket (Bun and Node), and rebuilds the pool so a kill storm's first OK read arrives within 3 s (B-02, B-43, D294). Other uncaught exceptions still print and leave a non-zero exit so `okm migrate check` / `apply` refusals are not reported as success on Bun.
- node-postgres defaults `timeouts.acquire` to 10 s and keeps an idle/checked-out client `error` listener that logs on the notice path without throwing, so a backend kill of an idle client does not crash Node (B-44, D294).

#### tooling

- CI copies the milestone from `Closes #N` onto the pull request before `lint / pull request`, so agents that cannot PATCH milestones still pass D206.
- The sticky migrate-plan comment matches the marker and the bot author, so another author's marked comment is not edited (B-22, D295).
- `okm driver test` drops leftover `okm_*` tables after each wire and error case, refuses Bun below `1.4.0`, and never reports an unrun case as `pass` (B-05, B-06, B-42, D295).
- `okmodel/testing` factories and `isolation()` work under `compositeTenancy()`; concurrent creates no longer false-positive as a factory cycle; matviews are refreshed in `isolation()` and documented otherwise (B-32, B-28, B-34, D295).
- The Bun.sql kill-storm test (B-03) retries post-storm scoped reads on `unavailable`/closed (bounded) so a dying reserved handle after the storm does not fail CI, without relaxing storm `short`/`leaks`/`readOnly`/`nested` asserts.
- `okm push` plans from the live catalog and applies each change under a fresh `push-<n>` id, so a second push is no longer skipped (B-29, D289).
- When the schema hash moves with no DDL (an external table the dependent already verified), `okm push` and `okm migrate apply` re-stamp `okm_meta` instead of leaving `connect()` on OKM1520 (B-21, D289).
- `okm migrate check` keeps a trigger's function in the logical namespace, so schemas with `timestamps({ enforce: "trigger" })` or hand-written triggers no longer fail OKM1020 (B-24, D289).
- `okm check` and `okm push` reprint domain checks on the connected server before planning, so a non-canonical author check is not permanent live drift (B-37, D289).
- The guide's `roles` block applies as a superuser and as a `CREATEROLE` schema owner: managed roles are created before `SET ROLE`, schema ownership is transferred when possible, and a failed role unit stays re-runnable with a clear privilege error. On Postgres 15, apply grants itself membership after `CREATE ROLE` (which leaves none); on Postgres 16+ it grants `WITH SET TRUE` (B-30, D293).
- Migrate strips the `pgbouncer` query parameter before the URL becomes a startup parameter; other pooler hints are not interpreted (B-25, D293). Provider-specific role-admin checks (RDS, Cloud SQL, Supabase) follow in M-4.
- The pooler pid probe uses eight reads on the apply session (OKM1854 when the backend pid changes). Warm-and-hold for LIFO PgBouncer is kept out of apply/seed so single-connection targets do not hang; URL heuristics still refuse typical pooler hosts and ports (B-41, D293).
- The type-change recipe's temporary `IS NOT NULL` validate is no longer OKM1531 (B-36, D289).
- An unknown CLI flag is an error; `okm <command> --help` lists that command's flags (B-26, D289).
- Backfill progress prints a 1-based step index (B-27, D289).
- `okm pull` and `okm import drizzle` write foreign keys with the exported table binding, keep file stems unique on case-insensitive volumes, and never write a Windows-reserved stem (`con`, `aux`, `nul`, `com1`, …). A column `__proto__` is a computed key. Composite primary-key columns stay not null on Drizzle import. Missing `oxfmt` prints a notice and still writes the report. `okm ext scaffold` includes composite types (B-14 to B-19, B-38, D290).

#### docs

- Tree, testing, driver-test, and Action docs cover cycle refusal, composite factories, minimum Bun, cleanup, and sticky-comment author matching (D295).
- Known limits record that Bun.sql does not park reserved handles, that a post-commit reset failure does not fail the call, and that a send-without-result is OKM1401 with no `afterCommit` (D288).
- `okm push` docs say it applies the live schema diff as `push-<n>`, and known-limits cover external re-stamp and domain-check sealing (D289).
- Sensitive docs cover redaction in logs, errors, `cause`, and spans; writes docs cover unknown keys (D291).
- Queries and the error reference document OKM1126 when a finished statement exceeds 65,535 parameters (D292).
- Guide roles privileges, production.md `--target` / status / check behavior, and known-limits pooler notes (DM-2, DM-3, D293).
- Known limits, README, guide, spec, and handbook pages match the code after the 0.9.1 fixes: Temporal polyfill on Node 22/24, `okm dev`, `okmodel/safety`, redaction, untyped `raw` and raw projection (B-07, B-08), minimum Bun, `okmodel.config.ts`, `listen` as a driver capability only, catalog export vs `describe`, backfill step numbering, and a Not tested section (DM-1 to DM-12, D296).

## v0.9.0 — 2026-10-16

### ✨ Added

#### dialects

- `okmodel/pg/unaccent`, `hstore`, `ltree`, `btree_gist`, `btree_gin`, `fuzzystrmatch`, and `pgcrypto` are generated extension packs. A feature the declared version does not include fails with OKM1812 and names `minPostgres`. `vector` is not in this version (D281).

#### tooling

- `describe(schema)` and `buildCatalog(description)` on `okmodel/migrate` return the catalog as JSON. The logical identity stays `public` when the catalog is placed. Reading the JSON back keeps the catalog hash (D284).
- `okm import drizzle <path>` writes table files from a Drizzle schema using the project's own `drizzle-orm` and the same emitter as `okm pull`. It needs no database. An existing file is OKM1855. A missing `drizzle-orm` is OKM1856. Composite foreign keys, `relations()`, and custom types are listed as not imported (D280).
- The GitHub Action `.github/actions/migrate` posts one sticky pull-request comment from `okm migrate plan --json`: the strictest class, each step's class and lock, row estimates, and lint codes. Preview applies a database the caller created and never creates or drops one (D279).
- `okm pull` reads a database and writes one table file per table plus the schema file. It is read-only, including on a protected target, and an existing file is OKM1855. Functions, triggers, views, policies, roles, and grants are listed under `not pulled yet` (D275).
- `okm migrate check` warns OKM1552 when a domain check or a `LANGUAGE sql` function body reprints, and OKM1538 warns only when the type change rewrites the heap (D276).
- `external(table)` marks a table another catalog owns. `okm catalog export` writes a snapshot whose `catalogHash` is separate from its logical identity. `defineConfig({ namespace, external })` places the catalog and verifies those snapshots. Two catalogs on one database keep separate history. A foreign key into another database is OKM1842 (D277).
- `okm pull` writes functions, triggers, views, and materialized views. A view is SQL with its columns. Views and `BEGIN ATOMIC` bodies take `dependsOn` from `pg_depend`. A plpgsql or SQL-string body gets lexical `dependsOn` candidates. A scratch replay with `check_function_bodies` on marks each function verified or candidate-only (D278).
- `okm ext scaffold <name>` prints a starting `extension()` definition from the connected catalog. `--out` writes that file and never overwrites. It is read-only, including on a protected target (D281).
- `okm ext test <file>` checks declared types, operators, functions, and index methods against the server. A wrong signature exits non-zero with the mismatch listed. A version the server does not meet is OKM1812. It is read-only, including on a protected target (D281).

#### docs

- A type change that rewrites the heap stays OKM1538, a warning with no automatic safe form. The documented recipe adds the new column, backfills it, dual-writes, switches reads, then drops the old column, each as its own migration (D285).

### 🐛 Fixed

- `btreeGin().gin` uses the `int4_ops` operator class that `btree_gin` creates.
- A `BEGIN ATOMIC` reprint is matched by the function name and its identity arguments, so two overloads do not share a body. A name that appears once is that row, so a typmod or an array is still reprinted. `orderBy` on a function call and computed fields stay after M2 (D282).
- The release smoke keeps asking npm while a published version is still processing: 31 times, 30 seconds apart, with `bun add --no-cache`. The job timeout is 45 minutes.
- `connect()` reads `okm_meta` and `okm_history` from the namespace `defineConfig` placed, so a second catalog's hash is checked at startup. `public` keeps the same query. A missing table still skips the check (D283).

### ♻️ Changed

- The execution plan schedules the 0.9 Tooling train as P110 through P119.
- 0.9.0 is the M2 gate. No gate or ceiling moved. `vector`, tool 5, `orderBy` on a function call, and computed fields stay deferred (D286).

## v0.8.0 — 2026-10-16

### ✨ Added

#### dialects

- `fragment` composes SQL in `where` and in `select` on `find` or `one`. A value is a parameter. `ident` names the field, the same name `where` uses, and a hidden field is refused. The tenant predicate stays (D266).
- `raw` and `explain` run typed SQL from a table handle. The row class names the columns. `"read"` or `"write"` is required. A scoped tenant read keeps the tenant predicate outside the fragment. A raw write on that table is OKM1702 and sends nothing. `explain` returns the plan outside production and sends nothing when `NODE_ENV` is `production` (D268).
- The value `fn()` returns is callable. `slugify(ident("title"))` is a `where` operand. `.as("slug")` names a `select` entry: a numeric return is a number, and any other return is text. `orderBy` does not accept the call. `view(name, (q) => q.from(table))` selects that table. A column list projects those fields. `materializedView()` stays SQL plus declared columns (D271).

#### adapters

- `okmodel/pg/neon` connects with `@neondatabase/serverless`. `websocket` is a pool and `tx()` works on a direct connection. `http` sends one request per statement, and `batch()` is the atomic call. `tx()` on HTTP is OKM1111. A positive timeout is refused. A transaction-mode pooler does not promise session state. With one small compute it reused a backend, so a custom `SET` was still visible on a second connection (D269).

#### runtime

- `insert({ id }, { allow: ["id"] })` writes a supplied id on a client-generator primary key. An omitted id in the same list is still generated. Without `allow`, a supplied id is OKM1190. A database default stays OKM1190 when `allow` names it. On a list, the type opens `id` only when `allow` is exactly `["id"]` (D272).
- `okmodel/otel` turns `hookm`, `onRoute`, and `inspect()` into OpenTelemetry `db.*` spans. You pass the tracer. Statement text stays off unless `statement: true`. Parameters and a tenant id are not recorded. An error span records the error name and an OKM code, and leaves out the message and the stack (D267).
- On a topology client, `inspect().routing.reason` matches `onRoute`. The preview does not call `onRoute` and does not move the selector. A string or a pool stays synchronous `single-endpoint` (D268).
- `connect` from `okmodel/pg/neon` returns a promise for a string, a pool, and a topology. Writes go to the primary. A replica can lag, and `route: "replica"` stays on that replica (D269).

#### tooling

- `okm driver test <driver>` runs the driver, error, and transaction suites and prints each case as pass, fail, or unsupported, with the capability that explains an unsupported case.
- `okm driver test neon` runs those suites. COMMIT loss is unsupported (`no socket to cut`). The Neon connect gate is 42,000 minified and 14,500 gzip (D269).
- A Windows job runs the audit checklist from the packed tarball. It is not a required check. A step that needs a TCP Postgres URL is skipped.
- The repository `.gitattributes` keeps migration SQL, catalog JSON, and `.okm` files LF on checkout (D237).

#### docs

- Offline-first constraints R1–R7 are recorded for the 0.8 train. They do not start a phase. P100 audits PostgreSQL and writes a report (D265).
- The P100 audit records what PostgreSQL already proves for R1–R7, and the gaps later phases still have to decide. No API change.
- The 0.8 type and byte budget is recorded (P101). No gate or ceiling moves. Ali approves it before P102.
- The drivers page covers Neon: WebSocket and HTTP, the pooler, a cold start, and replica lag (D269).
- The P108 study measures four inline-relation shapes. An opt-in entry types `as` and `has` without moving an existing ceiling. The default-path harvest and a loose `references()` store do not fit. No gate moves.
- Inline relations do not ship in 0.8. `relations` on the table remains how an include is named (D270).
- postgres.js and node-postgres results on Neon primary and primary-pool endpoints are recorded. A cause that was not established stays unclassified (D269).
- The OKE Windows audit records 32 surfaces: 27 work, 2 probably work, none fail, and 3 are unknown (#219).

### ♻️ Changed

- The spec status names the 0.8.0 release. Decisions run through D274.

### 🐛 Fixed

- `okmodel/pg/bun` typechecks without `bun-types`. The adapter declarations name the Bun.sql slice they use, so a consumer does not resolve the `bun` module.
- `okm migrate check` and `okm check` reprint a `BEGIN ATOMIC` body before they compare it. An argument qualifier Postgres prints, such as `by_id.n`, is not OKM1547 (D273).
- A raw read renumbers every `$n` marker in a multi-parameter tenant predicate once. Nine user parameters and `$1`, `$2` stay `$10`, `$11`.
- The bundle check leaves `@neondatabase/serverless` external, the same way it leaves `postgres`, `pg`, and PGlite external (D269).
- `okm check` matches a table file stem without case, so `Tasks.ts` with `import { tasks } from "./tasks"` is not OKM1024.
- Packed `okm driver test` finds `dist/tooling/driver-run.js` when the command itself is in a shared chunk. That entry does not import the `bun` package, so Node can run `pglite`. `okm driver test bun` loads the Bun adapter from a chunk of the same build and passes the same pool config as the other drivers.
- The packed bun driver test builds its own runner, so a Postgres consistency shard does not need a prior `dist/` build.

## v0.7.0 — 2026-10-15

### ✨ Added

#### dialects

- `minPostgres: 17` sets the oldest Postgres major this schema runs on. The majors are 15, 16, 17, and 18. Omitted means 15. `requires: { postgres: ">=17" }` stores the same floor. The floor is not part of the catalog hash (D261).

#### runtime

- `bucket(column, unit, { tz, as })` groups an aggregate by a calendar or clock unit. A day or longer returns `Temporal.PlainDate`. On a `timestamptz`, a second, minute, or hour returns `Temporal.Instant`. Those three units are refused on a `date`. A NULL timestamp is one group: the result key is present and the value is null. `__proto__`, `constructor`, `toString`, and `hasOwnProperty` are refused as `as`, and so is an `as` that matches another bucket. There is still no `having`. Time-zone date helpers stay deferred (D247, D257).
- `update` with `lock: "skip"` and `limit` claims up to that many unlocked rows in one statement. A read still uses `lock: "update"` and `wait: "skip"` inside `tx()` (D249).
- `find({ search })` and `count({ search })` match a column built for search. A string is enough when the table has one. Rows come back closest first unless you pass `orderBy`. `page()` does not take `search`. A `language` that is not text is refused. An empty or malformed language name is OKM1122. A well-formed name is sent to the server (D250).
- `relevance(query, { match, language })` orders a search column by the match. `matches` takes the same options. `{ mode, config }` is not accepted (D250).
- A to-many `include` with `orderBy` and `limit` returns the first N related rows of each parent. The primary key breaks ties (D251).
- `rowNumber`, `rank`, `denseRank`, and `runningTotal` go in `select` on `find` or `one`. A running total is the column's type, or null. `page()` refuses a window when the call runs (D251).
- `descendants(id)` and `ancestors(id)` read the rows below or above a row in one statement. Pass `relation` when the self-relations use different columns. The fix lists the names. A row already on the path is not entered again. `ltree` is not required (D252).
- `sync(id, relation, ids)` sets a to-many relation to exactly those ids and reports the links it added and removed (D252).
- `versioned()` adds `version`. An update passes the version you read and the write bumps it. A stale write is a conflict and changes nothing. Leaving `version` out is refused, and so is `version` on a table that is not versioned (D254).
- `sortable(groupBy?)` adds `position` and `move(id, { before })` or `{ after }`. New rows go at the end of the group. A move is O(n) per group and rewrites every row in the group. Naming the group column in `set` is refused. `find` and `page` order by `position` when you omit `orderBy` (D254).
- `morph("commentable", ["tasks", "lists"])` includes the matching target, with the type set to that table's name, or null. `morphMany` is the reverse many. `morphTo` sets the type and the id together. Setting one without the other is OKM1121. A type outside the list is OKM1120 (D255).

#### docs

- The handbook documents those calls, including what each one refuses. Define is Schema, Connect, and Config. Start is Let's start and Basic Usage. Table is a group: one page per part of `table()`, from the key through the queries. Keys, Checks, Presets, and Reference rows are split into subsections.
- Traits shows `trait(name, { fields })`. `touch` seals those columns and sets them to `now()` on update. `methods` and `requires` stay OKM1061. Each built-in trait shows the call: insert for timestamps, `archive` and `restore` for archivable, `version` on update, and `move`.
- Defaults shows what insert does with each form. A literal and `.defaultSql()` are stored and applied when the field is omitted. A generator runs in the application and stays out of the catalog. `t.id()` and `t.identity()` are omitted from input. `.default(null)` follows `.nullable()`. A generated column is `stored`.
- Shape shows the value you pass. An array element cannot be null. A picklist CHECK is `column IN (...)`, and `{ check: false }` still rejects a value at encode. Adding an enum label in order plans `ALTER TYPE … ADD VALUE`. Removing or reordering a label replaces the type.
- Names: insert and `where` use the field name. `sqlName` is what the statement quotes, and casing does not rewrite a name you set. `renamedFrom` plans `RENAME`. A comment is checked and left off the catalog.
- Visibility splits the options. `.hidden()` leaves the column off the row. `filterable: true` opens `where` and `orderBy` at runtime. `.sensitive()` takes no argument and redacts logs, errors, and `inspect()` as `[redacted]`. `.guarded()` stays closed until `{ allow }`. A sealed field and a tenant key stay closed. A tenant key update is OKM1704.
- Validation splits the options, and each option has a sample. `v.trim()` and `v.lowercase()` take no argument and change the stored string. `v.email`, `v.min`, and `v.rule` take an issue key. A bare `onInsert()` or `onUpdate()` limits the rules that follow. Passing one rule limits that rule and leaves the rest of the list alone. `validation: true` keeps the schema's `onRead` and `style`. `false` turns the table off. `insert.validate` returns a frozen row. `insert.check` returns the issues. `pick` and `omit` choose the fields. `{ validate: false }` skips that call.
- References splits each action. The constraint is `{table}_{column}_fkey`. A new table adds it with `alter table`. A table that already exists adds it `not valid`, then validates it. `onDelete` and `onUpdate` take `cascade`, `no action`, `restrict`, `set default`, or `set null`, and both can be set together. `set null` needs a nullable column. On a tenant table, `set null` and `set default` are refused. Omitted `columns` uses a one-column primary key. One name selects another column, which has to be the primary key or a unique.
- Relations names the include. `one` and `many` take `field` when more than one foreign key matches. A to-many include needs `limit`. `has`, `none`, and `every` filter a relation. `manyThrough` takes `through`, `from`, and `to`. `morph` uses `${name}Type` and `${name}Id`. Include is `true`. `morphTo` sets both columns.
- Indexes take column handles in order. One column, a column order, and several indexes are separate calls. The name is `{table}_{columns}_idx` and follows a column or table `sqlName` and snake casing. A new table uses `create index`. A table that already exists uses `create index concurrently`, outside a transaction. `.unique()` can sit beside a plain index and does not create a unique constraint.
- Checks take a name key and `sql` text. The constraint is `{table}_{key}_check`. The key is not recased. A handle is inserted as its SQL name. A number is inserted as text. Quotes around a string stay in the template. A new table uses `alter table`. A table that already exists adds the check `not valid`, then validates it. A failed row is `Check violation` with kind `check`.
- `filters().parse` returns `{ where, orderBy }` for `find`. Each operator is its own section. A scalar is equality. Several operators become `and`. `in` and `inList` become `inList`. `sort` is ascending. A relation field becomes `has`, and a column of the same name wins. A simple request is one field and a sort. A complex request combines operators, a relation, and `sort`, then spreads into `find`. A hidden field is OKM1123 when `filters()` is called.
- `trait()` takes `fields`, `touch`, `sealed`, and `presets`. A touched field is sealed. Schema traits apply first. `omitDefaults` drops them and needs a reason. A repeated column is OKM1012. A simple trait adds one field. A complex trait adds a touched column, a sealed column, and a preset.
- Tenancy adds a guarded uuid. `for()` sets it. Input cannot. A unique includes the key unless `.unique({ global })`. `global("reason")` leaves the column off. `via()` follows up to three to-one relations and does not store the key. A global table cannot reference a tenant table.
- A preset is a `where` you call on the table. A field, an argument, a list, a bound, `or`, and two `where` calls are separate sections. A chain keeps the caller's `where` first. Update and delete still need their own `where`. Insert does not use the preset. A reserved name is OKM1040. A trait preset sees the trait's columns.
- Required rows are the `reference` option. They are rows the application expects, such as statuses. Apply inserts a missing key and does not update or delete. They are not a foreign key and not a migration insert.
- Queries add `page`, a grouped `aggregate`, a string `search`, both tree walks, a list `update`, and `inc`. A window `as` that clashes with a column is OKM1120. `page()` still reads `select` as field names.
- Each table option is its own subsection with a sample. `t.id()` shows `uuidv7`, `uuidv4`, a client generator, and `none`. A tenant unique leaves the key out with `{ global: "reason" }`. `has`, `none`, and `every` each filter a relation. `onConflict` is `"ignore"`, `{ on, update }`, or `{ on, return: true }`.
- Schema is a group under Define. Each option is a page: Tables, Casing, Codecs, Row types, Id default, Minimum Postgres, Traits, Tenancy, Validation, Extensions, Functions, Triggers, and Views. `/docs/define/schema` is the overview. `/docs/define/schema/requires` redirects to Minimum Postgres.
- Tables is the list `schema()` compiles. A reference names a table in that list, earlier or later. The same name twice, two names that emit one type, or one SQL name twice is OKM1023. A missing name is OKM1020. Swapping the list does not change the catalog hash.
- Casing `"snake"` rewrites a camelCase table or column. `publishedAt` is `published_at`. `userID` is `user_i_d`. `sqlName` and `renamedFrom` stay as written. Any other value is `schema() casing … must be snake.`
- Codecs choose the TypeScript value of `t.bigint()`, `t.identity()`, and `t.numeric()`. The SQL type stays. `"string"` is a decimal string. `"number"` is a safe integer for bigint and can lose digits on numeric. `"bigint"` is a JavaScript bigint. A schema codec other than `"string"` needs the same `as` on every column of that type. Timestamps stay `"temporal"`.
- Row types store `"emitted"` or `"inferred"`. Omitting the field is `"emitted"`. Queries still infer from `schema()`. `okm build` writes `.okm/types.d.ts` for either value. `notes` becomes `Notes`, `NotesInsert`, and `NotesUpdate`. A `t.jsonb<T>()` argument is copied from the schema source. Any other value is `schema() types … must be emitted or inferred.`
- Id default replaces a bare `t.id()`. Omitted and `"uuidv4"` store `gen_random_uuid()`. `"uuidv7"` stores `uuidv7()` and needs Postgres 18. A client generator is filled on insert and stays out of the catalog. `okid()` is `text` with collation `C`. A column `default` wins. `"none"` is that column option. A Postgres floor below 18 on `uuidv7()` is OKM1812.
- Minimum Postgres is `minPostgres`, a major from 15 through 18. Omitted means 15. `requires: { postgres: ">=17" }` stores the same floor and is deprecated. A bare `t.id()` stores `gen_random_uuid()`. An explicit `uuidv7()` on a floor below 18 is OKM1812. A server below the floor is OKM1802.
- Traits is a list applied before a table's own traits. An omitted list and `[]` add nothing. `omitDefaults` drops the schema list and needs a reason. A repeated column is OKM1012. `timestamps({ enforce: "trigger" })` adds `okm_touch_<column>` and a before-update trigger.
- Tenancy is `columnTenancy()`, `compositeTenancy()`, or `rlsTenancy()`. Omitted, a table that sets tenancy is OKM1060. Each key is a guarded uuid filled by `for()`. `rlsTenancy` keeps the column predicate and refuses the owner, a superuser, and `BYPASSRLS` (OKM1707).
- Validation is stored as given. `schema()` does not run the rules. Omitted and `false` are off. `true` and an object are on. `style` is `inline` or `section`. A field in both places is OKM1030. A write without `okmodel/validate` is OKM1201.
- Extensions is a list of `citext()`, `pgTrgm()`, or `extension("name")`. The record is contributed when the catalog is read. An omitted `citext` column is OKM1020. A list that names another extension is OKM1810. The same name twice is OKM1813. An exact version is written. A `>=` floor is stored and is not written.
- Functions is a list of `fn()`. plpgsql needs `dependsOn` (OKM1824). `security: "definer"` needs `searchPath` (OKM1823). `LANGUAGE sql` that begins with `BEGIN ATOMIC` can omit `dependsOn`. Volatility defaults to `volatile`. Security defaults to `invoker`.
- Triggers is a list of `trigger()`. Identity is the table plus the name. The function must already be in the catalog (OKM1020). `updateOf` is SQL column names and needs an update event at level row. Events are stored as insert, update, delete, truncate.
- Views is a list of `view()` and `materializedView()`. Output columns are text. A tenant view that hides the key is OKM1820. `refresh: "concurrently"` needs a unique index (OKM1822). Creation is `WITH NO DATA`. `db.views.name.refresh()` refreshes a materialized view.
- The Table sidebar leads with columns, keys, defaults, references, relations, and queries. Names, visibility, checks, and required rows come last.
- Docs pages drop the breadcrumb. Copy page sits on the title row and opens Markdown and chat actions. A code block focuses the line the paragraph names.
- Connect is a group under Define: Drivers, Target, Topology, Check, Session, Errors, Generators, and Observers. `/docs/define/connect` is the overview, including `close()`. Session is the pool size, prepare mode, TLS, search path, and deadlines. Check includes the catalog artifact and `requireMeta`.
- Define Config is one page per `defineConfig` option. `/docs/define/config` is the overview.
- The handbook adds Reference and AI Resources. Reference is CLI, Errors, OKID, and Environment Variables. AI Resources is MCP, Skills, and LLM. Retired `/docs/reference/known-limits` and `/docs/reference/linter` still redirect to the docs home.
- The site tells agents where to read. Every response links `/llms.txt`, the sitemap, and `/.well-known/agent-skills/index.json`. A handbook URL also links its markdown page. `robots.txt` allows search, live AI input, and training. The published skill is `okmodel`. A browser with WebMCP gets `search_docs`, `get_page`, and `list_pages`.
- The home page is a hero over one stage with twenty-one real examples in three groups. Migrate shows eight schema edits (add a column, require a value, add a unique key, add a foreign key, add an index, rename a column, add a picklist, drop a table), each with the `schema.ts` diff, the planned migration with class and lock, the lint findings, and the type change. Model shows six (timestamps, soft delete, enum, view, a tenant column, row-level security). Query shows seven calls (a relation include, a cursor page, full-text search, an aggregate, a tenant-scoped read, archived rows, a hidden column), each with the SQL it plans, the rows it returns, and the rules `inspect()` lists. Everything is real output, from `okm generate` and from the client on PGlite, regenerated by `site/scripts/hero-derived.ts`, and a test fails when the checked-in output drifts. Previous and next arrows, a counter, and a progress line walk the examples, the stage has a maximum height and each side scrolls when its content is taller, and the prism behind the copy takes the tint of the shown one.
- Extensions, functions, triggers, and traits each end with Create your own. A name outside `citext()` and `pgTrgm()` is `extension(name)`. A function is `fn()`. A trigger is `trigger()`. A schema trait is `trait(name, { fields })` on the schema list.

### 💥 Breaking Changes

- `matches` takes `{ match, language }`. `match` is `natural` (the default), `all-words`, `phrase`, or `advanced`. `{ mode, config }` is not accepted (D250).

### 🔥 Removed

- Safety, Drivers, and Known limits are no longer their own pages. The reference pages are not published. `/docs/known-limits` redirects to the docs home.
- Queries is no longer its own page. `/docs/start/queries` redirects to the Queries page under Table. Table is no longer one page. `/docs/define/table` is the overview, and each section is its own page.
- Handbook pages no longer end with a Next link.

### 🐛 Fixed

#### runtime

- `insert` with `onConflict: { on, return: true }` returns the existing row when another transaction inserts it first, and does not change that row (D246).
- An update list of two different timestamps, dates, or byte values is not the same target (D246).
- `update` with `lock: "skip"` matches the physical row by `tableoid` and `ctid`, so a claim does not change another partition or an inheritance child that shares the `ctid`. A path-parent update uses the same pair (D249).
- Concurrent inserts into one `sortable()` group no longer pick the same `position`. The advisory lock is its own statement, and the max is read after that lock is held (D254).
- `bucket()` refuses `as: "__proto__"`, `constructor`, `toString`, and `hasOwnProperty` before it writes the row (D257).
- `rowNumber`, `rank`, `denseRank`, and `runningTotal` refuse `__proto__`, `constructor`, `toString`, and `hasOwnProperty` as the result name. The error is OKM1120, names the key, and is raised before any SQL (D258).
- `find` and `count` with an explicit `search: undefined` are OKM1120, the same as `""` and `null`. A call that omits `search` is unchanged (D259).
- `bucket()`, `rowNumber`, `rank`, `denseRank`, and `runningTotal` refuse the rest of the `Object.prototype` names, and `then`, as the result key. The error is the same OKM1120 sentence (D259).
- `sync` on a tree-shaped `many` refuses an id list that contains the parent's own id and writes nothing. The message says "tree". `manyThrough`, including a row that links to itself, is accepted. Other relations are unchanged (D259).
- A malformed advanced search is OKM1120 and names the search input. A missing text search configuration is OKM1122, including `public.english`. Other syntax errors stay `driver` (D260).
- `morphTo` with a null name, a null type, or an id that is not a non-empty string is OKM1120. An empty string name or type stays OKM1020 (D260).
- Updating a tree parent to the row's own id is OKM1120 when `where` is the primary key. A filter that is not the key is not checked (D260).
- `update` with `limit` and `returning: true` returns the updated rows and honors `select`. Without it the result stays `{ count }` (D260).
- `update` with `{ allow, returning: true }` is typed as the updated rows, and that is what the call returns.
- `delete` with `{ returning: true }` is OKM1120 and deletes nothing. The option type does not accept `true`. Pass the field names, or omit `returning` for `{ count }`.
- An include `select` that names a hidden column is OKM1120. A default include still omits the column (D260).

#### dialects

- A `42601` whose message names `tsquery`, or whose statement is a search predicate (`to_tsquery`), is OKM1120. An unescaped backslash is included. Other syntax errors stay `driver` (D263).

#### adapters

- A server error whose text contains `CONNECT` is no longer treated as a lost connection. Classification uses the driver `code` and SQLSTATE (`08` and `57P01`–`57P03`) only. A live session is rolled back and released. A session that is gone is released without a rollback (D244).
- On PGlite, a JS number, bigint, or boolean bound to a column is sent as wire text. A parameter protocol error (`08P01`) is kind `driver`. A closed connection stays `unavailable` (D259).
- Bun.sql drops a pooled connection on a closed signal or `57P01` before the next statement uses it. A read that failed because that connection was already dead is tried once on a new connection. A write, a lock, or a statement inside a transaction is not retried (D260).
- Bun.sql rejects a wire integer outside the signed int8 range as kind `invalid`, including an id of 2^64. A numeric value written as that integer is refused too (D260).
- PGlite `connect(pool)` then `close()` marks that client closed. Later calls are `unavailable`. The pool stays open (D260).
- A reserved Bun.sql handle whose backend was killed fails the next statement with `unavailable` (SQLSTATE `08006`, retryable) after the pool drains the closed socket. A scoped read does not come back empty (D263).
- On postgres.js, a wait with no call deadline is rejected when every slot in its pool has closed, or when the reserved connection it uses closes. A queued `reserve` is started again after a close, because the driver drops that `sql.reserve()` without settling. A wait that already has a deadline is not on the close hook (D263).
- The timestamp conformance statements set the session time zone to UTC, so the wire text does not depend on the server time zone.

#### tooling

- `okm migrate check` does not open a second connection to drop the scratch schema when the replay rolls back (D245).
- The replica probe test has a 15 second budget, so a loaded CI runner no longer fails it on the default 5 second limit.
- `bun run attw` runs `node_modules/.bin/attw` from the repository root and fails with a clear error when that binary is missing.
- `bun run pack-tracked` packs the tarball and fails when a file in it, other than `dist/`, is not tracked by git. `bun run check` runs it. The release publish job runs it with `--release`, which also fails when the worktree is dirty.
- The docs site hero and theme control use inline SVG icons again so the client shell does not import `lucide-react`.
- Streaming replication waits poll for 45 seconds before `routing.auto` fails on a slow catch-up.
- The postgres.js adapter incremental gate is 16,000 minified bytes. The room is the close rule (D263).

#### docs

- The docs site favicon is the OKM mark: a white letter on a dark rounded square. It cycles O, K, then M on its own icon link, so opening a page does not rewrite the static icon.
- The favicon morph keeps the letter visible. The paths sit in the same box as the OKEngine mark, so the blur does not wipe the tile.
- The Schema page lists extensions as `citext()`, `pgTrgm()`, or `extension("name")`. Config states each option once.
- Text search: `natural` combines unquoted words with AND. `advanced` is raw `to_tsquery`. A syntax error in that query is OKM1120 and names the search input. A missing text search configuration is OKM1122. An empty or malformed name is still OKM1122 when the statement is built (D259, D260).
- A claim returns `{ count }` unless `returning: true`, which returns the updated rows, including when `{ allow }` names a guarded field. `delete` does not accept `{ returning: true }` (OKM1120, and the row stays). The handbook sets a `claimedBy` token, then `find`s by that token (D259, D260).
- PGlite is a pool of one. A statement issued while a `tx()` is open waits until it ends, unless `timeouts.acquire` is set (D259).
- A morph write can store another tenant's id. The include reads as the caller, so that target is null (D259).
- An include `select` that names a hidden column is OKM1120. A default include still omits it (D260).
- `okm migrate check` runs the statements it is given. Run it as a non-superuser (D259).
- The first call after a backend kill on an idle connection is `unavailable` and retryable. Bun.sql retries a client read once at transaction depth 0. postgres.js and node-postgres do not. A kill during a postgres.js connect can leave an unhandled rejection from the driver's type-catalog query (D263).
- A postgres.js wait with no call deadline is rejected on a close only when every slot in that pool has closed, or when the reserved connection it uses closes. A queued `sql.reserve()` is dropped by the driver without settling when a slot closes. okmodel starts it again. A wait that already has a deadline ends at that deadline (D263).
- Docs search answers `GET /api/search?query=` with the matching pages. An empty query and a query with no matches return an empty list. The static index stays on the server.
- A trigger that also fires on insert names `new` in `when`. Postgres rejects `old` on an insert event.
- `extension("hstore", { schema: "extensions" })` needs `create schema "extensions"` before apply. The column type is `extensions.hstore`, because that type is not on the search path.
- The traits insert is awaited. `await using` closes the client when the function returns, so a returned promise closed it before the row was written.
- The docs site reads the repository `package.json` by walking up to the manifest named `okmodel`. A Next output manifest with a trailing comma is not that file.

### ♻️ Changed

#### dialects

- A `uuidv7()` default on a floor below 18 is OKM1812 and names that major. A server below `minPostgres` is OKM1802. A server below 15 with no floor is OKM1803. The handbook page is Minimum Postgres (D261).
- A bare `t.id()` stores `gen_random_uuid()`, so it works on Postgres 15 to 18. `defaults: { id: "uuidv7" }` keeps the old database default. An explicit `uuidv7()` on a server below 18 is still OKM1812 and needs `minPostgres: 18`. An existing table whose default is `uuidv7()` plans `SET DEFAULT gen_random_uuid()` and does not rewrite the table (D262).

#### runtime

- `update` of a list refuses the same target twice (OKM1120). A target that matches nothing is not an error. An empty `set` is OKM1120. An empty list runs no statement (D246).
- `inc` is a number or bigint column. A text column is OKM1124. A list that sets one field with `inc` in one row and a plain value in another is OKM1120. A null number stays null (D249).
- `.stream()` yields rows in keyset batches on every driver, including PGlite. The default batch is 1000. `limit` is the total. A table with no primary key, `one()`, `count()`, `exists()`, `search`, and a window are refused. A positive `timeout` is the budget for the whole stream, including on a driver that cannot cancel. A row committed while it runs can be seen or missed (D256).

#### adapters

- A closed pool reports SQLSTATE `08006` with the message `The pool is closed.`

#### tooling

- The size gates for the featureless app and the connect entries measure the static startup graph. Dynamic import targets are empty modules in that build (D248).
- The docs site has no sync step. `site/content/docs` is the handbook and is checked in. Each page carries its title and description in frontmatter, and each folder's `meta.json` sets the sidebar order. `site/handbook`, `scripts/sync-docs.ts`, and `lib/docs-map.ts` are removed. The site check now verifies that every page is listed in its `meta.json`.
- The docs site deploys to production only after a release is published. A push to `main` no longer updates the public site, so the site shows the published version.
- The docs site publishes when the workflow moves the `release` branch to the release commit. Vercel builds that branch. The workflow no longer calls the Vercel CLI, and the repository no longer needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`, or `VERCEL_PROJECT_ID`.
- A release requires the commit that was QA'd. The tag must point at that commit, `package.json` there must match the tag, and the published provenance must record that same commit.

#### docs

- The docs site uses IBM Plex Sans.
- The site header shows the OKM wordmark. The home link is named OKModel.
- The header wordmark is one step smaller. The theme control uses the Lucide moon and sun.
- The home page hero reads "Edit your schema. Get a safe migration." with a pitch for the migration, lint, and types the stage shows. The package description is unchanged.
- Known limits record the lost-connection release path and that a sortable move is O(n) per group.
- The changelog page shows `## Unreleased` as next until the release.
- The published README is the short page: the logo, install, a schema, `okm push`, and basic usage. The full walkthrough is `docs/guide.md`. A README image has to be an absolute `https://` URL. The docs site is `https://okm.omqkhafi.dev`.
- The spec status names the 0.7.0 release. Decisions run through D264.

### ⚠️ Deprecated

- `requires: { postgres: ">=17" }` still sets the floor and is deprecated. Use `minPostgres` (D261).

## v0.6.0 — 2026-10-11

### 💥 Breaking Changes

- Generated unique and foreign-key names use every SQL column after `casing` and `sqlName`. A primary key stays `{table}_pkey`. A picklist check stays the SQL column. A named check keeps the author's name. Indexes are unchanged. A catalog with a multi-column unique or foreign key changes `catalogHash`. Upgrade with `okm migrate apply` once. The plan is `RENAME CONSTRAINT` and does not drop the object or the rows. A protected target needs `--allow-protected` on that invocation. `ALTER INDEX … RENAME` is `SHARE UPDATE EXCLUSIVE`. A database created before this spelling plans only those renames, and the next plan is empty. `connect()` on the old catalog is OKM1520 until apply. A violation through `connect()` still reasons the stored name key. The column-tenancy fixture hash is now `df7f8549fea5cde8e35a21e84541900abfe30fd605f4af0e7e98792f66aab32b`. The small tasks schema is `d029ad2cc216ec1b89062614a881d81841e7dbb1fc33602f9fd33203a1bc8461` (D234, supersedes the TypeScript-name formula in D223).
- `columnTenancy()` takes one key. A key list is `compositeTenancy()`. `tenancy: { via: "..." }` is not a strategy. Use `via()` from `okmodel/tenancy`. A handwritten object is rejected when the schema is built (D229, pre-v1).
- `filters({ allow })` accepts only the operators `parse` applies. `path`, `matches`, `similar`, `wordSimilar`, `or`, `and`, `none`, `every`, and the write operators are a type error (D233, pre-v1).

### ✨ Added

#### dialects

- `db.views.name.refresh()` runs `REFRESH MATERIALIZED VIEW` on a materialized view, with `CONCURRENTLY` when the view declares it. A plain view has no `refresh()` in its type. The statement is a write, and it is not tenant-scoped (D227).
- `filters().parse` applies `not`, `containedBy`, `overlaps`, `hasKey`, and `hasAnyKey`, and a `relations` allowlist becomes `has`. The allow type is `FilterOperator` (D233).

#### runtime

- `compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" })` isolates on every key together. `tenancy: via("project.organization")` isolates a table through up to three relations. `for()` takes every key. A column-only import does not load either factory (D228, D229).
- `rlsTenancy({ key: "tenantId", type: "uuid" })` adds PostgreSQL row-level security behind the column predicate. Tenant tables get forced policies, each scoped call sets `app.tenant` for that transaction, and a view over those tables is `security_invoker`. A superuser, a `BYPASSRLS` role, or the table owner is refused on the first scoped call (D231).

#### tooling

- `roles.reporting` is a read-only role: select on tables, views, and materialized views, usage on schemas, and default select on later tables. A hidden column stays out of that select unless `roles.columns` names it. The role is not `BYPASSRLS`. `roles.columns` grants select or update on named columns. `withOwner(table(...), "ignored" | "external")` keeps a table out of the plan. Apply grants the application role select on `okm_meta` and no other privilege there (D232).
- `isolation()` reads tenant views and materialized views after seeding the underlying tables. A global view is skipped and listed (D233).

#### docs

- The startup budget audit for train 0.6 records where the bytes in each gated graph go, the headroom under the current gates, and the measured cost of the smallest hook for each 0.6 feature. It does not move a gate (D218).
- The docs site in `site/` publishes the handbook from the repository markdown, with search, per-page markdown, and a changelog page. The home page links install, the first query, schema, and migrations.
- Learning pages for install, the first query, schema, queries, safety, migrations, and drivers are written in the site handbook. Repository docs stay under Reference. A public fence that names a shipped API is type-checked against the built package.

### ♻️ Changed

#### dialects

- The extra unique beside a tenant primary key keeps the stored name key `{primary fields}_{tenant field}`. Its SQL name is the column list (D234, supersedes the TypeScript spelling in D223).

#### adapters

- Bun.sql and PGlite throw OKM1120 (kind `invalid`, message `timeout`) when a positive `timeout` is passed. They do not cancel a statement that is already running. `timeout: 0` is still kind `timeout`. A `signal` on its own is unchanged (D224, D239).
- A `timeout` or `signal` still does not settle an in-flight statement on Bun.sql or PGlite. The fix grew Bun.sql by 108 / 39, so it was not shipped (D224).

#### runtime

- Inside `tx()`, `app.tenant` is set again when the statement's scope differs from the last one in that transaction. A rolled-back savepoint does not leave the transaction unscoped (D238).
- A where with no effective predicate is checked from the write and archive chunks. A read does not carry that walk. The runtime entry stays 5,288 / 2,026. The featureless app is 90,506 / 30,063 (D219).
- A hidden column named in `where` or `orderBy` is OKM1120. `hidden({ filterable: true })` allows those two clauses and still leaves the column out of the default row. `filters()` still refuses it (OKM1123). The catalog hash is unchanged. The featureless app is 90,721 / 30,154, under the 90,900 / 30,170 gate (D226).
- The hidden `where` and `orderBy` check was measured in three forms. The smallest reuses `fail()` and fits under the current gates: the featureless app would be 90,718 / 30,143 (D225).

#### tooling

- A pull request labelled `needs: postgres` runs the Postgres suite as four shards per version, each with its own database, and proves the pooler beside those shards. `gate / check` waits for the suite and the tarball. A skipped Postgres slice fails that gate while the label is present (D230).

#### docs

- The reporting role is not tenant-safe against its own SQL. It can set `app.unscoped` and read every tenant through the select policy. It still cannot write (D238).
- `okm seed` under `rlsTenancy` runs as the application role. The owner gets OKM1707. `isolation()` and `testing()` on PGlite or a superuser harness are the same error. The supported path is a non-superuser role on a real Postgres through `open({ url })` with `migrate: false` (D239).
- `UNIQUE (id, tenant_id)` stays beside `PRIMARY KEY (id, tenant_id)`. Two tenants can share an id. Composite foreign keys and `onConflict` target the unique. `archivable()` turns it into a partial unique index, which a primary key cannot be (D234, D239).
- Known limits put the Bun.sql and PGlite `timeout` refusal on the first screen. A populated materialized view is not RLS-protected (D239).
- The plan schedules M2 Depth as four trains: 0.6 Access (P80–P86), then 0.7 Query depth, 0.8 SQL lane, and 0.9 Tooling. Access is first. Each feature loads lazily, or the step stops with numbers. The OKE prototype starts after 0.6 (D217).
- Known limits name the driver reasons `undefined_table`, `undefined_column`, `tls`, `not_populated`, `no_unique_index`, and `not_owner`. The handbook covers composite, path, and row-level tenancy, the reporting role, and the constraint-name upgrade from 0.5.1. A production database that is behind the app is OKM1520 until `okm migrate apply`.
- The 0.6 gate remeasured the six startup graphs. Minified and gzip bytes match the previous sample, so the gates stay. The featureless app has 138 minified and 31 gzip left under 90,900 / 30,170. The same ten tables with column tenancy are 97,735 / 32,468 (D235).

### 🐛 Fixed

#### contracts

- `.okm/catalog.json` and `catalog.hash` are checked after a UTF-8 BOM is stripped and every carriage return is removed. An LF catalog keeps the hash `okm build` wrote (D237).
- A postgres.js connect that does not finish (`CONNECT_TIMEOUT`) is kind `unavailable`.

#### dialects

- `okm check` sees row-level security that was turned off. Introspection omits policies while `relrowsecurity` is false, so the plan enables and forces them again (D238).
- A column grant or revoke lowercases only the privilege keyword. `tenantId`, `Mixed Case`, a reserved word, and a snake_case column stay quoted byte for byte in `roles.reporting` and in `roles.columns` select and update (D241).
- `rlsTenancy` stores the policy text Postgres prints. A lowercase unreserved column stays bare, so a snake-case `tenant_id` catalog hash does not change. `tenantId`, `TenantId`, and a reserved word are double-quoted. Apply of a default-casing key no longer fails with `column "tenantid" does not exist`, and `okm check` reports no drift (D236).
- A materialized view no longer keeps the application role's table default privileges. The plan revokes `INSERT`, `UPDATE`, and `DELETE` after `SELECT`. The catalog stays select only (D236).
- A superuser passes the managed-role `CREATEROLE` preflight when `rolcreaterole` is false (D236).
- `refresh()` waits until it is awaited. `batch([view.refresh()])` is OKM1121 and runs no statement. An unawaited failure is not an unhandled rejection. The refresh sets `app.unscoped` on a reserved primary connection, so the owner sees rows under `FORCE ROW LEVEL SECURITY`. The application role is `not_owner`, and the error names the migration role. A plain view has no `refresh` at runtime. `refresh: "blocking"` and any other value is OKM1120 (D239).
- `okm build` keeps `t.jsonb<{ published?: boolean }>()` and `t.json<T>()` in `.okm/types.d.ts`. A bare `t.jsonb()` stays `jsonb<unknown>` (D215, D239).

#### adapters

- postgres.js does not `ref` or `unref` a socket that is not writable. A closed socket no longer stacks `connect` listeners, so Node does not print `MaxListenersExceededWarning`. A connect that does not finish rejects the statement.

#### runtime

- The first scoped statement on each endpoint checks the role and the policy expressions. OKM1707 names that endpoint. A policy changed to `using (true)` fails the check, and `isolation()` fails with it (D238).
- A policy that is missing, not forced, or not the one okm emits is OKM1708. The guard resolves the table with `to_regclass`, so a schema named after the connected role does not hide it. The check still runs once per endpoint and generation (D241).
- Statements of different scopes on one transaction connection run one at a time. Each sets its own `app.tenant` before the statement, so one scope cannot return the other's rows (D241).
- `tx({ timeout })` and `batch({ timeout })` on Bun.sql and PGlite are OKM1120, the same refusal as a per-call timeout. A `signal` is not refused (D241).
- postgres.js no longer crashes the process when the backend dies inside `tx()`, including while the transaction is idle between statements, inside a savepoint, or just before `COMMIT`. The pending statement and the transaction reject with `unavailable`, or OKM1401 when a `COMMIT` may have happened, and the next call still runs. A lost reserved connection is not written again, so the driver never schedules the null-socket `setImmediate` write, and the process `setImmediate` stays the one the application installed. A node-postgres or Bun.sql stream interrupted by a lost connection is `unavailable`. A postgres.js stream can still end a page early with no error (D242).
- A node-postgres idle client that the server closes no longer crashes the process. The pool drops that client and the next query opens a new one. A `LISTEN` connection that the server closes is the same: one error handler covers the pool and that client, the client is released, and a later query still runs. The connect entry measures 42,661 minified and 15,066 gzip. The gate stays 42,850 / 15,070.
- OKM1707 says `okm seed` under `rlsTenancy` runs as the application role. The owner gets this error (D239).
- A trailing backslash on the catalog directory is ignored, and a Windows stack frame still records `file.ts:line` (D237).
- `onConflict: { on: "title" }` on a tenant unique of (tenant key, title) updates that tenant's row. The conflict target includes the tenant key. Naming the tenant key is still OKM1104. Two tenants can keep the same title (D221).

#### tooling

- A hand-written step that disables row-level security, stops forcing it, drops a policy, widens one with `using (true)` or `with check (true)`, grants `BYPASSRLS`, or changes the owner of a tenant table is OKM1550. `okm migrate check` and apply refuse it unless the step has `-- okm-allow OKM1550: reason` (D238).
- OKM1550 also flags a create or alter policy on a tenant table that is not the emitted expression: `using (1=1)`, `using ((true))`, `using (true or false)`, `alter policy … to public using (1=1)`, and an extra permissive policy (D241).
- `okm migrate check` lints before it replays. The replay creates its scratch schema inside one transaction, sets the search path there, and always ends with `ROLLBACK`. It does not edit system catalogs or real ACLs. `COMMIT`, `ROLLBACK`, and other transaction control in a step is OKM1551. Apply accepts that step only with `-- okm-allow OKM1551: reason`. `VACUUM`, `CREATE DATABASE`, `DROP DATABASE`, and `ALTER SYSTEM` are skipped and named. A concurrent index runs without `CONCURRENTLY`. A plain owner passes check (D242).
- A step that kills its own backend during `okm migrate check` or `okm migrate apply` exits non-zero with `unavailable` or OKM1401. The process does not hang. Check drops the scratch schema, or the error names it when the drop cannot be confirmed.
- OKM1551 reads a dollar-quoted body only when the statement is `DO`. `CREATE FUNCTION` and `CREATE PROCEDURE` may contain `COMMIT` or `ROLLBACK`. Top-level transaction control and a `DO` body stay refused.
- Reprinting a view during `okm migrate check` runs as the login user. `SET ROLE` does not stay in effect for that schema, so a migration role can own `public` and the check still creates the reprint schema (D242).
- A path foreign key is planned after the unique it references. Table names no longer decide that order. Drops reverse it (D236).
- `okm generate` then apply accepts an index on a materialized view. The stored document depends on the view, not on a column, for one column or several, unique or not (D236).
- `GRANT USAGE ON SCHEMA` that does not land fails with OKM1825. The migration role has to own the schema (`ALTER SCHEMA … OWNER TO`). `okm migrate check` gives that role its scratch schema and replays the grant there (D236).
- `withOwner(..., "ignored" | "external")` is omitted from generated SQL and from provisioning. `okm check` still ignores both (D236).
- A CRLF or lone-CR migration file is read as LF. Apply, `okm migrate check`, the linter, and `okm migrate status` see the same steps. A non-empty file with no steps and no `-- no steps` line fails instead of printing `nothing to apply`. A hand-written `truncate` is OKM1542 in LF and in CRLF (D237).
- A UTF-8 BOM is stripped from migration SQL. UTF-16 is refused. The kind stays `invalid` (D237).
- `schema`, `tables`, `migrations`, `out`, and a seed path resolve from the project directory. An absolute path and a `..` path both work (D237).
- `okm generate init` writes `.gitattributes` so migration SQL, catalog JSON, and `.okm/` stay LF. An existing `.gitattributes` is left as it is (D237).
- `okm` on Node older than 22.18 stops and names `bun --bun okm`. `engines.node` is `>=22.18` (D237).
- `okm migrate check` keeps a constraint whose only difference is the stored name key. Postgres does not store that key, so a replay no longer drops and recreates it. The reference app migration `0004_sql_names` renames the constraints whose SQL names changed (D234).
- A `CREATE FUNCTION` or `CREATE PROCEDURE` with a SQL-standard `BEGIN ATOMIC` body stays one statement. Semicolons in the body do not split it, and the closing `END` is not OKM1551. A nested `CASE ... END` does not close the body. Top-level transaction control, a `DO` body, and `BEGIN ATOMIC` outside those statements stay refused.
- The Postgres workflow caches with `actions/cache` v5.1.0, which runs on Node.js 24.

#### docs

- Known limits and the migrations page describe a Windows checkout: CRLF, a BOM, resolved paths, a TCP URL, and case-sensitive file names (D237).
- `okm migrate check` should run as a non-superuser. A superuser replay can execute `COPY ... PROGRAM` and `lo_import`. `CREATEROLE` is not required for the replay.
- Known limits record the postgres.js stream gap: a lost connection can end a page early with no error, and a later `cursor.next()` on a dead socket can throw outside the promise. node-postgres or Bun.sql is the stream to use when failover matters. The 0.7 backlog reclaims adapter and featureless-app bytes before adding that loop (D242).
- The handbook names draft 26, and the opening size table is the current sample.
- Known limits and the drivers page no longer say postgres.js prints `MaxListenersExceededWarning` after a lost connection.

### 🔒 Security

- An update that sets a path column checks the new parent in that same statement. A parent in another tenant, a missing parent, or a parent deleted while the statement waits is OKM1705, and the row stays. `batch()` refuses that update before it runs. `tx()` is the verified form.
- `archivable()` on the table a path ends on is refused when the schema is built (OKM1705). The fix names that table. A path child can still be archived.

## v0.5.1 — 2026-10-08

### ♻️ Changed

- A pull request no longer runs the Postgres suite. The label `needs: postgres` runs the suite on 15 and 18 and the tarball on 18, in the same Actions run as the other checks. Adding that label without a push starts it on its own and does not cancel the run. `bun run verify` runs that suite on this machine. The release and the weekly run still cover 15 through 18 (D212).
- A pull request update is one Actions run. Checks are named `area / piece`, so each one reads `CI / area / piece`. Long test groups are split (`migrate` and `migrate pg`, `drivers` and `rows`, `schema`, `columns`, and `schema pg`, `tenancy`, `client`, and `client pg`, `package`, `contracts`, and `safety`). Node and Deno are `runtimes / portable`. Path labels and the pull request lint are jobs in that run. The required status is `gate / check` (D213).
- Running the Postgres suite with no database is loud. The preflight names the unreachable primary and how many files would skip, and `CI=true` fails instead of running. Each skipped Postgres test counts toward a final `N Postgres tests SKIPPED` line (QA-R2, D216).
- CI runs the date/time codecs on Node 22 and 24 with `temporal-polyfill` and on Node 26 natively, in a `temporal / node` job that joins the `gate / check` needs. The Postgres suite workflow proves the D215 pid probe refuses a transaction-mode pgbouncer with OKM1854 on every suite run (QA-R3, D216).
- `bun run type-cost` measures a 250-table inferred schema beside the other probes and fails above measured +20% (21,180 instantiations). Check time is reported, not gated (QA-R4, D216).

### 🐛 Fixed

#### runtime

- `update`, `delete`, `archive`, and `restore` now refuse a where with no effective predicate, including undefined values (QA-C1, QA-H2). A field value is a leaf. `eq` keeps a timestamp, a date, bytes, or a jsonb object in the filter. A bare object stays OKM1121 (D125, D210).
- An `or()` branch with no effective predicate is now refused, in reads and in writes (QA-H1). `or([])` still matches nothing.
- `or()` with a non-array or with more than one argument is now refused (QA-M4).
- An unknown key on `update`, and `tx` with the function before the options, are now refused (QA-M2).
- A bad option on `find`, `one`, and `count` now rejects the query, so `safe` and `catch` see OKM1120 (QA-M11). `page` and `aggregate` already did.
- A read on a replica that refuses or drops the connection falls back to the primary on postgres.js, node-postgres, and Bun.sql. `onRoute` reports `fallback:unhealthy`. A driver error with an empty message now has text (QA-M1, D214).
- Closing a client before it connects no longer leaves an unhandled rejection. `connected` rejects with an `unavailable` error that says the client was closed first (QA-M5, D214).
- OKM1104 lists each accepted constraint once and does not name the tenant key, which every unique includes (QA-L11, D214).
- OKM1200 reads `Validation failed: <field> <reason>` and names the first failing field (QA-L12, D214).

#### dialects

- Compiled SQL for a tenant table keeps the tenant predicate on every table alias, including a where that compares an object through `eq` (QA-S4).
- A missing table or column maps to `undefined_table` or `undefined_column`, with a fix that names `okm migrate apply` and `okm migrate status`. Calls that share one caller signal now share one abort listener instead of adding one each (QA-L8, D214).
- A TLS or certificate failure maps to `unavailable` with reason `tls` and a fix that names `sslmode` (QA-L9, D214).
- `filters().parse` no longer throws a TypeError on `constructor`, `__proto__`, `toString`, or `hasOwnProperty`. A key that is not allowlisted is OKM1123. Parse applies `eq`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `between`, `startsWith`, `endsWith`, `contains`, `like`, and `ilike`. An operator the allow type accepts and parse cannot apply is OKM1120 when `parse()` runs (QA-M9, D215).
- The shipped `Temporal` declaration is empty interfaces, so it merges with TypeScript's Temporal lib and with `temporal-polyfill` (QA-L2, D215).
- Emitted row types keep `jsonb<T>` and write an optional insert column as `x?: T` (QA-L3, D215).
- `fn({ searchPath })` is checked as a comma-separated list of identifiers when the function is built (QA-S3, D215).

#### tooling

- The commit-cut harness waits until the server has answered `COMMIT` before it drops the client. A fixed delay could reset the socket first, so the transaction rolled back while the caller still got `outcome_unknown`.
- A hand-written migration step is linted per statement. A leading comment, a second statement, a semicolon inside a comment, `DO` and `CALL`, and `ALTER COLUMN … TYPE` can now be refused (QA-H3). `-- okm-allow` on the step silences that code on every statement of the step.
- Port 6432 counts as a pooler. Apply, seed, and check refuse a backend pid that changes between two statements, with OKM1854, unless `--allow-pooler` is set (QA-M6, D215).
- `okm check` on a schema with `citext` and a view exits 0. The scratch search path includes the schemas that hold extension types, then restores the previous value (QA-M7, D215).
- `isolation()` uses a new tenant pair each run, asserts only on the row it inserted, deletes that row, and names a missing factory. It covers aggregate, page, batch, and stream when the client has them (QA-M8, D215).
- A CLI error prints `error <code>: <message>` and the fix, and exits 1. The stack is printed only with `--verbose` or `OKM_DEBUG=1` (QA-M10, D215).
- The published `package.json` no longer carries the `workspaces` field. The pack step strips it from the tarball only; the root keeps it, and the tarball smoke test asserts it (QA-R1, D216).
- Apply's `failed at step N` counts from 1, the same number the linter prints. Status still prints the stored index (QA-L5, D215).
- A renamed table's plan row estimate uses the old table's row count (QA-L6, D215).
- `okm`, `okm help`, `okm --help`, and `okm -h` print the commands and exit 0. `okm <command> --help` prints that command (QA-L7, D215).
- Apply refuses a database whose `standard_conforming_strings` is off (QA-S2, D215).

#### docs

- Temporal values keep microseconds. Showing one passes `fractionalSecondDigits`. The codecs do not warn (QA-L1, D215).
- `db.views` keys are camelCased. A materialized view is refreshed with `REFRESH MATERIALIZED VIEW` until a `refresh()` handle in 0.6 (QA-L10, D215).
- `lists_touch` is the trigger `timestamps({ enforce: "trigger" })` installs on a table named `lists`. `archivable()` installs no trigger (QA-L13, D215).
- Hidden columns in `where` and `orderBy` are unchanged. The options for 0.6 are recorded in D215 (QA-S1).
- `timeout` and `signal` on Bun.sql and PGlite do not settle a call whose statement is already running, and an outer-client call inside a PGlite `tx()` callback queues behind the transaction instead of throwing (QA-M3, D216). Neither driver can cancel an in-flight statement, and the client-side race did not fit the size cap, so both stay known limits. OKM1192 is reserved for the later refusal.
- Date and time columns need a `Temporal` global. Bun and Node 26 have it; Node 22 and 24 need the polyfill line before the columns are used (QA-D1, D216).
- The `okm` bin's shebang is node: `bunx okm` runs with Node, `bun --bun okm` selects the Bun runtime, and a `.ts` config needs Node 22.18 or newer (QA-D2, D216).
- The update/delete rule names its codes: no effective predicate, including undefined values, is OKM1102, and an empty `or()` branch is OKM1121 (QA-D3, D216).
- The linter page states the statement split, comment handling, and the `DO` and `CALL` rule (QA-D4, D216).
- Circuits start closed, so the first read goes to a replica without waiting for a probe (QA-D5, D216).
- Known limits records the M3 outcome, sub-microsecond rounding on write, the PGlite outer-client queue rule, and the thirteen `filters().parse` operators (QA-D6, D216).
- Production states the pooler refusal: the refused hosts and ports, the pid probe, and `--allow-pooler` (QA-D7, D216).
- The views section shows the camelCase handle and the `REFRESH MATERIALIZED VIEW` refresh (QA-D8, D216).
- Catalog identity and constraint names wait for 0.6, with the rename design (QA-L4).

## v0.5.0 — 2026-10-07

### ✨ Added

#### runtime

- `connect({ primary, replicas })` opens one pool per endpoint and probes each replica. A string or a pool is unchanged and does not load that code (D201).
- Reads on a topology go to an eligible replica. `route: "primary"` or `"replica"` forces a read. `db.using("primary" | "replica")` returns a client with no `close` and no `using`. `onRoute` reports the choice, and a throw from it is ignored. `routing.fallback` is `"primary"` or `"error"`. A required replica that is not eligible is OKM1843. An automatic read with `fallback: "error"` and no eligible replica is OKM1844. A write, transaction, or locking read on a replica scope is OKM1840. A string or pool client serves either `route` from its one endpoint and has no `using`. `inspect()` stays `single-endpoint`. Routing reasons in `inspect()` are the M2 dev inspector (D202).
- `routing.select` chooses the replica: `weighted` (the default, smooth weighted round-robin), `roundRobin`, `leastConnections`, `latencyAware`, or a function. A weight of 0 is OKM1120. A saturated replica is skipped on an automatic read. If every healthy replica is saturated, the read uses the primary (`fallback:saturated`) or OKM1844. `route: "replica"` still uses a saturated replica. A connection failure retries once with the same strategy (D203).
- `routing.consistency` is `"session"` (the default) or `"eventual"`. A committed write reads `pg_current_wal_insert_lsn()` before its promise resolves when replicas are configured. That is one extra round trip. Later reads use a replica that has replayed at least that far. The root, `for()`, `unscoped()`, `using()`, and `reserve()` share that watermark. A failed position read keeps automatic reads on the primary (`fallback:position-unknown`, or OKM1844) until the next successful read. A primary probe already in flight does not clear that state; only a probe started in the same unknown generation does. `route: "replica"` and `using("replica")` are OKM1843 while the position is unknown or no replica satisfies it. Healthy replicas that are behind report `fallback:behind` (D204).
- `routing.maxLag` accepts `"5s"`, `"500ms"`, `"2m"`, `"16MB"`, `"512KB"`, `"1GB"`, and `"4096B"`. A bare number or any other form is OKM1120. A caught-up replica has lag zero. A custom `select` receives that lag in bytes, or `null` when it is unknown (D204).

#### tooling

- A migrate target that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845. The command does not resolve that URL.
- Issues and pull requests follow one GitHub standard: one `type:` label, at least one `area:` label, a `type(scope):` title, and a milestone. A check on the pull request adds the `area:` labels from changed paths, then enforces it. Dependabot opens grouped weekly `chore(deps)` updates, labelled, with no issue or milestone required (D206).

#### docs

- A reference app in `packages/reference-app` (private, not published): a multi-tenant project tracker on public entry points, with traits, archive, three generated migrations, a function, views, and the replica topology. CI runs it in the `postgres` and `tarball` jobs: use cases with query counts and `isolation()`, two preview databases at once from the snapshot, a rehearsal on a populated `TEMPLATE` clone, and read-your-write as the application role. `docs/example-app.md` describes it (D207).
- The README covers the 0.5 topology: `connect({ primary, replicas })`, automatic read routing, `route`, `db.using`, `routing.select`, consistency, `onRoute`, and OKM1840, OKM1843, OKM1844, OKM1845, and OKM1846, plus the reference app as the worked example. The session-watermark cost and the fallback rate under write load are recorded for a primary and two standbys (D209).

### ♻️ Changed

- An automatic read uses `routing.select` instead of the first healthy replica.
- The session wrote flag is gone. A read after a committed write follows the commit position.

### 🐛 Fixed

#### dialects

- View scratch verification creates the schema's functions before its views, so `okm check` passes for a view that calls a declared function (D208).
- `archivable()` writes the partial unique index predicate the way Postgres prints it, `(archived_at IS NULL)`, so a unique column on an archivable table no longer drifts after every apply. Stored catalogs change once (D208).
- A function grant names its argument types from `oidvectortypes`, so `EXECUTE` on a function with named arguments no longer drifts, and `okm doctor` and the apply preflight check that grant instead of skipping it (OKM1825) (D208).
- Grants and default privileges target the schema they are applied to. `okm migrate check --provision` with `roles` no longer grants on the target's own objects (D208).

#### runtime

- `db.views` is typed from `schema({ views })` on connected, scoped, and routed clients. Each field is the camel-cased column name, typed `string | null`. Types only (D208).
- Smooth weighted round-robin clears the current weight of a replica that did not take part in a pick. After that replica is eligible again, a heavier replica keeps the next read (D205).

#### tooling

- `okm migrate check` reads each scratch schema with that schema as the search path. A declared view and a function that takes a schema enum no longer fail with OKM1547 or OKM1020 (D208).
- `okm migrate check` with `roles` keeps default privileges in the scratch schema, so it passes and no longer writes them to the target's `public` (D208).
- Roles, grants, and default privileges are left out of the stored catalog hash and the `.okm` artifact. `connect()` after an apply with `roles` no longer fails with OKM1520 when `catalogDir` is not passed. `okm check` still verifies them. A catalog without roles hashes as before (D208).
- `okm migrate apply` moves a hash stored before D208 to the new hash when it is exactly the old hash of a migration already applied, also when nothing is pending, and prints `restamped <migration id>`. A protected target needs `--allow-protected`. Any other hash is left as drift (D208).
- Upgrade, archivable with a unique column: after upgrading, `connect()` is OKM1520 and `okm check` is OKM1510 (`OKM1529 creates a unique index`). Run `okm generate archive_predicate`, add `-- okm-allow OKM1529: rebuilds the same index` above the `create unique index concurrently` line, then `okm migrate apply`. `okm migrate check` still reports OKM1547 at the migration that first created the index, as it did before; see known limits (D208).
- Upgrade, a database applied with `roles`: after upgrading, `connect()` is OKM1520 until `okm migrate apply` runs once (`--allow-protected` on a protected target). It prints `restamped <migration id>` (D208).
- `okm migrate apply` on several databases of one cluster at once no longer fails when they create the same managed role. Every apply but the first failed on `pg_authid_rolname_index` with a raw driver error. `CREATE ROLE` now ignores a role another session created first, in the step runner and in the snapshot install, and later `ALTER ROLE` steps still run (D207).
- `isolation()` no longer fails with OKM1120 on a schema with a tenant-scoped view. It checks tables only; a view that hides the tenant key is still OKM1820 in `okm check` (D207).

## v0.4.0 — 2026-10-06

### ✨ Added

#### runtime

- When the catalog hash differs, `connect()` reads `okm_history` and uses the stored class. Ahead by expand migrations succeeds. Ahead by a contract migration, or behind the app, is OKM1520. The message names the migration, and the fix says to apply it or change the deploy order. `requireMeta` is unchanged (D197).
- A `catalog.hash` file makes that mismatch load `.okm/catalog.json` instead of rebuilding the catalog from the schema. Concurrent connects in one process parse the file once. A missing file, or a hash that does not match, is OKM1027. Equal hashes still return without that read.

#### tooling

- `okm migrate plan` prints a `pg_class.reltuples` estimate on each lock line when a selected target is reachable: `about 4.2M rows`, `rows unknown (table not analyzed)`, or `new table`. A safe rewrite is labelled on that line. `ACCESS EXCLUSIVE` on more than one million estimated rows, outside a safe rewrite, prints a note and is not a lint finding. No target, or a target that cannot be reached, prints the lock alone. `okm generate` stays offline, and the estimate is not written to SQL, catalog files, or `okm_history` (D194).
- The migration linter flags a drop, a rename, a column type change, a required column with no default, a dropped default, a shorter length, and a new unique, check, or foreign key on an existing table as errors.
- On an existing table the planner emits the safe form: a concurrent index create and drop, a check or foreign key as `NOT VALID` then `VALIDATE`, `SET NOT NULL` through a validated check, a volatile default split into a batched fill, and a unique or primary key from a concurrent unique index (D193). A new table keeps the plain statements.
- A failed concurrent index leaves an invalid index. Resume drops it and rebuilds, and does not repeat a finished step.
- `okm generate` prints findings and still writes the file. `okm migrate plan` and `okm check` exit non-zero on an error finding. `okm migrate apply` lints migrations that are still pending on the target and refuses with OKM1510 before any DDL or data statement.
- An override is `-- okm-allow OKM15xx: reason` on the line above the statement. An empty reason, or a code the statement did not trigger, is OKM1510 and does not silence another code.
- A backfill step stays one idempotent `UPDATE` in the migration file, with `-- backfill table=… key=… batch=…`. Apply runs it outside the migration transaction, one commit per batch, and resumes from `okm_backfill`. A table with no primary key is OKM1546. `defineConfig({ backfill })` sets the batch size (1,000), the pause (none), and the statement timeout (30 seconds). A protected target still needs `--allow-protected` (D195).
- `okm migrate status` lists an unfinished backfill under the target table: migration, step, rows so far, last key, and state.
- `okm migrate check` replays every migration into a scratch schema, plans each result back to that file's catalog, checks the previous catalog, requires the last catalog to match the schema, and lints the history (D196). Success prints `ok N migrations`. A remaining step is OKM1547, including a fork (`migration X was generated from a different parent than Y`). An expand migration that drops something the previous catalog relies on is OKM1548. A stale head is OKM1549 and the fix is `okm generate`. A protected target is refused: point the command at a throwaway Postgres. `--allow-protected` does not apply.
- `defineConfig({ lintFrom: "<migration id>" })` is the adoption baseline for `okm migrate check`. Files before that id are not linted. Apply still lints pending migrations only.
- `okm migrate status` prints `current`, `behind by expand`, `behind by contract`, `ahead by expand`, `ahead by contract`, or `failed at step N (resume with okm migrate apply)`. The command stays read-only on a protected target (D197).
- `okm migrate apply` on an empty target installs the head snapshot and `reference` rows, records `provisioned@<migration id>`, and does not replay steps. A non-empty target with no history is OKM1851. An empty protected target is allowed without `--allow-protected` (D198).
- `table({ reference: { key, rows } })` inserts a missing key on provision and on every apply. It does not update or delete. The rows stay on the schema and out of the catalog hash.
- `provision(target)` from `okmodel/migrate` provisions one configured target under the same rules.
- `okm migrate check --provision` compares that snapshot with a full replay. A difference is OKM1521 and names the object. The default check is unchanged.
- OKM1542 flags `insert`, `update`, `delete`, `merge`, and `truncate` outside a backfill step. Reference inserts are not migration steps, so they are not flagged.
- `okmodel/testing` exports `testing(schema, { driver })`. It opens a real driver pool (`open()` from `okmodel/pg/pglite`, or `open({ url })` from `okmodel/pg/postgresjs`) and returns `db`, `factories`, `expectQueries`, `isolation`, and `close`. A factory fills a required column from its type, replays from an optional seed, and `x.ref` reuses a row in the same tenant. `expectQueries` fails with the statements that ran and does not count transaction control. `isolation()` runs each tenant table's basic queries under tenant A against a row of tenant B and names a leak (D199).
- `okm seed <file>` calls the module's default export with that harness on the selected target. A protected target is OKM1850 unless `--allow-protected`. Several targets need `--target` (OKM1853). The command prints the rows the factories inserted.

#### docs

- `okm migrate check` has a CI recipe that starts Postgres and runs the command. The previous-catalog check is schema-level and does not prove application behaviour. Tenant targets and schema-per-tenant checking stay M5. Startup compatibility is the `connect()` check in D197, not this command.
- Provisioning and reference rows are documented, including where the rows live and what `--provision` compares (D198).
- `docs/testing.md` documents factories, `expectQueries`, `isolation()`, and `okm seed`. Spec section 20 names `okmodel/testing` as an export and uses `open()` from `okmodel/pg/pglite`.

### ♻️ Changed

- Drop default, a `NOT NULL` column with no default on an existing table, drop identity, `SET GENERATED ALWAYS`, and `ALTER ROLE` are classified contract. `okm migrate plan` prints each step's class and lock.
- A removed picklist or enum value, and a volatile default on an existing table, are filled by that batched backfill. The final rows match the single `UPDATE` they replace. `okm migrate plan` adds `about N batches` when a row estimate is available.
- OKM1534, OKM1535, OKM1536, and OKM1537 are errors, and they fire only when the statement is not the safe form. A type change that rewrites the table (OKM1538) stays a warning. `timestamp` without time zone, `varchar(n)`, `serial`, `json`, and an identity that is not generated always stay warnings on `okm check`.

### 🐛 Fixed

#### tooling

- `okm check` treats a column default and the cast Postgres stores for that column's type as the same value. `'x'` matches `'x'::text` on a text column. A different value still plans `SET DEFAULT`. The catalog keeps the text that was written.
- `okm check` also ignores a length or precision Postgres omits from that cast. `'x'::character varying` matches `varchar(10)`, `'x'::bpchar` matches `char(n)`, and a `timestamp(3)` cast without the precision matches the same literal. A cast to another type still plans `SET DEFAULT`.
- A provision that stops after creating objects and before writing `provisioned@` is OKM1851 on the next apply. The message names the object and says to drop the schema or database and run again. Apply does not replay over that target and does not delete it. Managed tables with no history row and no other objects are still empty.
- A table `renamedFrom` plans `ALTER TABLE … RENAME TO`, then renames a primary key, unique or check constraint, foreign key, index, or identity sequence when the name is the default `{table}_…`. A custom name stays. An add and a drop with no declaration is still OKM1530 (D194).
- Two serializable transactions in the conformance suite no longer write at the same time. One commits first, so the other is the only victim and the retry count stays one.
- `okm check` creates domain and enum types in its scratch schema before the stub tables, so a view over those columns can be sealed.
- A view, materialized view, table, sequence, or function that a plan drops and creates is granted again afterwards. Postgres drops the grant with the object.
- Introspection reads a constraint `nameKey` from the default name, so a check declared as `emailPresent` still matches the live database.
- `bun run db:up` binds three free host ports when 55432, 55433, or 55434 is already taken, and records them for the next CI step. Release smoke no longer stops when the runner is already using 55432.

## v0.3.0 — 2026-10-05

0.3.0 adds extensions, domains, functions and triggers, views, and roles and grants, and checks that each one round-trips.

### ✨ Added

#### dialects

- `extension()` from `okmodel/ext` declares an extension. `schema({ extensions })` stores those objects and, when the catalog is built, asks each one for its record. `citext()` (`okmodel/pg/citext`) and `pgTrgm()` (`okmodel/pg/pg_trgm`) are the built-ins. `pgTrgm.similar` and `pgTrgm.wordSimilar` are where filters.
- A second declaration of the same extension is OKM1813. A `citext` or `ltree` column whose extension is missing from a non-empty list is OKM1810. Omitting the list leaves the existing dependency check (OKM1020).
- Migrations create an extension before the tables that use it, upgrade with `ALTER EXTENSION … UPDATE` (the step is `path-unverified` until apply checks `pg_extension_update_paths`), move a relocatable extension with `SET SCHEMA`, and drop with `DROP EXTENSION` and no `CASCADE`. A downgrade or a non-relocatable move is OKM1814. Apply checks `pg_available_extensions` before any statement (OKM1811). An unpinned declaration matches whatever version is installed.
- `pgTrgm.gin()` and `pgTrgm.gist()` store a `using gin` or `using gist` index with `gin_trgm_ops` or `gist_trgm_ops`. The plan creates that index, and introspection of it matches the declaration.
- `t.domain(name, base, check)` is a catalog type. The column's TypeScript type and codec are the base column's. Creating the domain, changing its check, and dropping it are planned. A check change is `ALTER DOMAIN … ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT`, then a drop of the previous check, and never `CASCADE`. Changing the base type is OKM1020. An enum cannot be the base (OKM1060).
- `fn()` and `trigger()` from `okmodel/fn` declare functions and triggers. `schema({ functions, triggers })` stores them. A function's identity is schema, name, and argument types, so overloads are distinct. A trigger's identity is table and name. plpgsql without `dependsOn` is OKM1824. `security: "definer"` without `searchPath` is OKM1823.
- A plan creates types and tables, then functions, then triggers. The same signature is `CREATE OR REPLACE` and the step is marked `behavior: change`. A return-type change drops dependents and recreates them, and never uses `CASCADE`. A drop goes in reverse and is refused while a dependent remains (OKM1821). Triggers are dropped before their functions.
- `timestamps({ enforce: "trigger" })` adds a before-update trigger and its function, with timestamps provenance. `LANGUAGE sql` that starts with `BEGIN ATOMIC` takes its dependencies from `pg_depend`.
- `view()` and `materializedView()` from `okmodel/view` declare views. `schema({ views })` stores them. A view is SQL with declared columns. Appending columns is `CREATE OR REPLACE` and the step is marked `behavior: change`. An incompatible replace, or a change to a column the view reads, drops the dependents and recreates them, and never uses `CASCADE`. A drop goes in reverse and is refused while a dependent remains (OKM1821).
- A materialized view has no `CREATE OR REPLACE`. Creation is `WITH NO DATA`, and populate is a planned data step. `refresh: "concurrently"` needs a unique index (OKM1822). Scratch verification reads column dependencies from `pg_depend` and stores the server reprint of the query.
- `db.views.<name>.find(...)` reads a view. Writes are not on the handle. A view that exposes the tenant key takes the tenant predicate. A view that reads a tenant table and does not expose the key is OKM1820 in `okm check` unless declared `global("reason")`.
- `defineConfig({ roles: { migration, app } })` adds role, grant, and default-privilege objects. A name is external unless it is listed in `managed`. A managed role is created when `pg_roles` does not have it, altered in place, and never dropped. Grants and default privileges are for the application role on every managed table, view, materialized view, sequence, and function. Fine-grained grants stay in M2.

#### tooling

- `okm ext list` prints the extensions the connected server can install and the version that is installed. `okm ext check` compares those versions with the schema. A missing extension is OKM1811. A pin the server does not meet is OKM1812. `okm ext test` and `okm ext scaffold` are not in this version.
- `okm doctor` lists the triggers on each table. `okm doctor OKMxxxx` prints that code. When `roles` is set, doctor also checks that an external role exists, that a managed role can be created (`CREATEROLE`), and that the application role can reach each managed object (OKM1825).
- The 0.3 gate pushes an extension, a domain, a function, a trigger from `timestamps({ enforce: "trigger" })`, a view, a materialized view, and roles onto an empty database, checks for no drift, alters each one, and removes it without `CASCADE`. An extension the server cannot install is OKM1811 before any statement.
- Apply runs migrations as the migration role. When that role exists and is not `current_user`, the runner issues one `SET ROLE` before any statement and records it on the run report. The statement is not a plan step. `CREATEROLE` is checked before any statement when the plan creates or alters a role. `CREATE ROLE` has no `IF NOT EXISTS`; a role that already exists is skipped.

#### docs

- Known limits: a typed call such as `fn.slugify(col)` is not in this version, `inspect()` does not list triggers, a plpgsql body is `prosrc`, and a `BEGIN ATOMIC` body is the server reprint.
- Known limits: a view is SQL plus a declared column list, and `db.views.<name>.find(...)` is read-only. The query builder form (`view(name, (q) => q.from(...))`) is not in this version (D190). Column dependencies come from `pg_depend`. The stored query is the server reprint. `refresh: "concurrently"` is not stored by Postgres, and the plan's first populate is a plain `REFRESH`. `security_invoker` is not set.
- Known limits for roles and grants: fine-grained grants are M2, a role is never dropped, OKM1825 is doctor only, and a function grant is `name(argTypes)`. The non-owner RLS check moved to M2.
- Known limits name this version. Typed `fn` calls, builder-defined views, `okm ext test`, `okm ext scaffold`, column-level grants, and row-level security stay unbuilt. A domain check or a `BEGIN ATOMIC` body that differs from the Postgres reprint only by parentheses or casts is still a plan change. `okm check` does not warn. Write the text Postgres prints.
- The README names PostgreSQL 15 to 18, lists what 0.2 and 0.3 ship, and adds `okm ext list`, `okm ext check`, and `okm doctor` to the command table. The size rows are the `bun run size` output. The version line is 0.3.0 and the 0.3 roadmap item is done.

### ♻️ Changed

- Startup gzip replaces lazy chunk ids with a fixed id of the same length before compressing, so a chunk whose only change is its content hash does not move the number.

### 🐛 Fixed

- `okm check` reprints each view and materialized view with `pg_get_viewdef` on the connected server before it compares. A query Postgres 15 prints differently from Postgres 18 is not drift after push. A query that reprints to something else still is.
- `okm_meta` and `okm_history` stay out of the author diff. Plan, push, check, and doctor neither create nor drop them, in either direction.
- A primary key's name key is `pkey` in the schema and in introspection. `CREATE TABLE` writes that constraint's name, so a name other than `{table}_pkey` round-trips. After push, `okm check` reports no drift for a plain key, a composite key, and a named key. When `okm_meta` already exists, `okm check` compares the database with the schema and reports OKM1520 if they differ.
- A plan treats a schema type spelling and the Postgres `format_type` spelling as the same type (D191). `timestamptz` matches `timestamp with time zone`, and the same for `timestamp`, `time`, `timetz`, `varchar(n)`, `char(n)`, and the integer, boolean, float, and `decimal`/`numeric` aliases. Length, precision, scale, and array ranks stay. An unknown name is compared as written. `varchar(20)` to `varchar(30)`, and `timestamp` to `timestamptz`, still alter. After push, `timestamps({ enforce: "trigger" })` plans to no steps.

## v0.2.1 — 2026-10-05

0.2.0 was tagged but never published to npm, so 0.2.1 is the first public release and includes everything listed under 0.2.0.

### ♻️ Changed

- `bun run type-cost` prints a `query-200+batch` row (a `batch` of an insert, an update and a delete). It has no ceiling. The types of `batch` are unchanged: refusing `restore` and `expect` at compile time was measured and not built, and the known limits say why (D184).

### 🐛 Fixed

- The release workflow now publishes the tarball by explicit path (`npm publish ./packed/okmodel.tgz`). A bare `packed/okmodel.tgz` was read by npm as a `user/repo` git shorthand, and the publish step tried to clone `github.com/packed/okmodel.tgz`. A test now fails when any `npm publish` argument in a workflow does not start with `./` or `/`.
- `t.id()` on Postgres 15 to 17 with `schema({ requires })` not declared no longer fails with the raw `function uuidv7() does not exist`. `okm migrate apply` and `okm push` raise OKM1812 before they send any statement, so nothing is created, not even `okm_meta`. The message names the column, the migration and the server version, and the fix names both options: Postgres 18 with `schema({ requires })`, or `t.id({ default: "uuidv4" })`. A server that already has a `uuidv7()` function is not refused. Nothing changed in `connect()` or the runtime entry.

## v0.2.0 — 2026-10-05

### ✨ Added

#### contracts

- `Input` is the row a validated insert accepts. `OkmError` carries `issues` (`path` and a message key) when validation fails.

#### dialects

- `schema({ tenancy: columnTenancy({ key: "tenantId", type: "uuid" }) })` rewrites tenant tables once before compile. Each gains a guarded uuid key, a primary key of `(id, tenant key)`, and `UNIQUE` on those columns. `.unique()` becomes `UNIQUE (tenant key, column)` unless `.unique({ global: "reason" })`. Foreign keys between tenant tables include the tenant key. `global("reason")` opts a table out.
- A reference can list several target columns. `along` names the other local columns, so a composite foreign key is an ordinary constraint. Relations join on every column of the key.
- `t.id()` still defaults to database `uuidv7()`. `t.id({ default: "uuidv4" })` uses `gen_random_uuid()`. `t.id({ default: "none" })` has no default and is required on insert. A column choice wins over `schema({ defaults: { id } })`.
- `schema({ defaults: { id } })` sets the generator for every bare `t.id()`. `"uuidv4"` and `"uuidv7"` stay database defaults. A function is filled in the application.
- An OKID id is `text` with collation `C`. Collation is part of the catalog: create, diff, introspect, and plan.
- `.hidden()` stays out of default selects and includes, and is returned only when a root `select` names it. `.sensitive()` redacts the value in logs, errors, and `inspect()`.
- `filters()` is synchronous and throws OKM1123 when `allow`, `sort`, or `relations` names a hidden field. `parse()` loads the parser on first use.
- `schema({ traits })` applies those traits to every table. A table opts out with `omitDefaults` and a reason. A field the table already declares is OKM1012.
- `archivable()` turns a table's unique constraints into partial unique indexes (`WHERE archived_at IS NULL`). The primary key stays a full constraint. A tenant unique keeps the tenant key and the same predicate.
- `contains`, `containedBy`, `overlaps`, `hasKey`, `hasAnyKey`, `path`, and `matches` filter json, array, range, and tsvector columns. Text `contains` stays a substring. The value, key, or path is a parameter, and a regconfig name is checked before it is bound.
- `json.set`, `arr.append`, and `arr.remove` are namespace exports used inside `update`. Importing one does not pull the others.
- `.validate()` stores rules on a column. A table `validate` section stores rules by field, and `$row` stores cross-field rules. `schema({ validation })` and `table({ validation })` store the switch. `schema()` does not pack or run them.
- `schema({ validation: true })` marks that schema's insert body as `Input`. A boolean that is not the literal `true`, an object form, and a table-level `validation` switch do not change the type. The validate methods are added by importing `okmodel/validate` and are not part of the table type.
- Importing `okmodel/validate` types `insert.validate`, `insert.check`, `pick`, `omit`, `update.validate`, and the Standard Schema members on a table that validates, by module augmentation. A program that does not import it does not see those types and pays nothing for them. The `Input` mark follows the schema's `validation` option or the table's own, in the boolean and object forms.
- `manyThrough("labels", { through: "taskLabels" })` declares a to-many relation through a join table. Name `from` and `to` when the join table has more than one foreign key to a side. It works in `include`, in `has` / `none` / `every`, and in filters. The join rows and the targets carry the tenant and active-set predicates, so a row in another tenant or archived never shows. The relation carries its own resolver and emitter, so a schema without one does not ship them.
- `t.custom({ ..., accepts: ["Object"] })` names the object kinds a custom codec takes. Without it every object is refused for that column (OKM1121).

- `table({ presets })` and `trait(name, { fields, presets })` declare named, typed query refinements. A preset is `(q, ...args) => q`, its arguments are typed, and the builder has one method, `where`, which adds a predicate. No method removes or replaces one. A reserved or client-method name is a type error. `PresetQuery` is exported for presets written apart from the table.
- A trait's presets are merged into each table's set through the trait object. A schema-level trait's presets reach every table that keeps the defaults. A name defined by a table and a trait, or by two traits, is OKM1040, and its fix names both sources.

#### adapters

- `okmodel/pg/pg` connects with node-postgres, and `okmodel/pg/bun` connects with Bun.sql. Both are optional peers. The default stays postgres.js. Bun.sql loads only on Bun.
- node-postgres cancels an in-flight statement and returns notices. Bun.sql does not abort an in-flight statement and does not surface RAISE NOTICE. Neither describes a statement without running it. A plain pool of either exits after the last query.
- A postgres.js, node-postgres, or Bun.sql connection reserved for `tx()` that is lost is dropped and never written to again. A COMMIT cut by a lost connection is `outcome_unknown` (OKM1401), and no ROLLBACK follows it.

#### runtime

- `okmodel/tenancy` exports `columnTenancy` and `global`. `for({ tenantId })` puts the tenant predicate on every read, write, include, and `has` / `none` / `every` filter. `unscoped("reason")` omits the predicate and `inspect()` shows the reason. Insert still needs `for()`. The root client omits tenant tables. Calling one is OKM1701. Input cannot set the key, including `{ allow }` (OKM1190). Naming it in a filter or an update is OKM1704.
- An index on a tenant table that does not lead with the tenant key is OKM1706. A global table that references a tenant table is OKM1705. `set null` and `set default` are refused when the foreign key includes the tenant key.
- `registerTenancy()` records the tenancy check. A tenant key set by input is OKM1190. The package does not register the rule on import. An application that does not import `okmodel/tenancy` does not load that code.
- `connect()` refuses a Postgres server below 15 with OKM1803. `schema({ requires })` that names an older major keeps the OKM1802 check instead.
- `okmodel/ids` exports `uuidv4`, `uuidv7`, and `okid`. Pass one to `.default()` or `defaults.id`. A literal passed to `.default()` stays a database default. `.defaultSql()` stays a database expression. The generated value is not in the catalog, so changing a generator does not produce a migration. Insert fills each omitted value once, including each row of a batch, and the returned row carries it.
- `connect({ generators })` replaces a built-in generator by name.
- An operator that does not fit its column fails with OKM1124. The message names the column type and the operators that column accepts. Text search on a text column says it needs a tsvector column.
- A table records the file and line where it was defined. `inspect()` shows that location on the catalog rules, a schema error includes it, and `okm` prints it. The catalog hash does not.
- `okmodel/safety` is the registry later checks plug into. `registerRule` adds a rule, `verify` throws OKM1190 with every violation in stable order, and `safety.property` fails when rule order changes the verdict.
- `okmodel/traits` exports `timestamps()` and `trait()`. `timestamps()` adds `createdAt` and `updatedAt`. Insert leaves both to `now()`. Update sets `updatedAt` to `now()` and leaves `createdAt`. Input cannot set either, including `{ allow }`. An application that imports no trait does not load that code.
- `registerTimestamps()` records the timestamps check. A timestamp set by input is OKM1190. `{ allow }` does not clear it.
- `registerFieldExposure()` records the hidden, sensitive, and guarded checks. A hidden field shown, a sensitive value revealed, or a guarded field set without `{ allow }` is OKM1190.
- Unknown keys are dropped on insert and update. A guarded field is OKM1190 unless `{ allow }` names it. `allow` does not unlock a primary key on update.
- `okmodel/traits` exports `archivable()`. It adds `archivedAt` and `archiveId`. `archive()` returns `{ count, archiveId }` and hides the matching rows, including named children, in one statement. `restore()` returns `{ count }`, clears both columns, and brings back only rows that share that `archiveId`.
- Reads, updates, and deletes see the active set. `withArchived()` and `onlyArchived()` change that view. `delete()` stays permanent. Purge is `onlyArchived().delete(...)`. A dynamic call on a table that is not archivable throws OKM1052. `strategy: "table"` throws OKM1061.
- `registerArchive()` records the archive rules. An application that does not call `archivable()` does not load the archive statement.
- `okmodel/validate` exports `v`. Importing it adds `insert.validate`, `insert.check`, `pick`, `omit`, `update.validate`, and the Standard Schema surface. The engine loads on the first validated call. An application that does not import it does not load that code.
- A validated write runs transforms, then derived checks (length, required, integer range, precision, picklist, uuid, json), then the caller's rules. A failure is OKM1200. A value returned by `validate()` is frozen and is not checked again. `{ validate: false }` skips that call.
- A write that would validate throws OKM1201 before any statement, and before a transaction is opened, when `okmodel/validate` was not imported. The category is `input`. A schema that does not enable validation still writes. A failed engine import still rejects the call.
- `page({ orderBy, limit, after })` returns `{ items, next }`. It is a keyset on `orderBy` with the primary key appended, and it is stable while rows are inserted. The cursor holds the order and the values as the database wrote them, so a timestamp keeps its microseconds. A cursor used with another `orderBy`, or one `page()` did not return, is OKM1130. The tenant and active-set predicates apply to every page. The planner loads on the first `page()`.
- `aggregate({ where, groupBy, count, sum, avg, min, max, orderBy, limit })` returns grouped rows with the tenant and active-set predicates of any read. `groupBy` needs `limit` or `.all(reason)`. `orderBy` takes `groupBy` fields. There is no `having` and no `bucket`. A hidden field is refused. The planner loads on the first `aggregate()`.
- Aggregates decode with the source column's codec. `count` is a number, `min` and `max` follow the column, and `sum` and `avg` keep the value type of the column: an exact decimal string for `numeric` by default, a number for `numeric` with `as: "number"` and for integer and float columns. A column whose value is neither a string nor a number is OKM1124.
- `.required()` on `one()` and a `one()` without `orderBy` that matches more than one row (`not_unique`) have real-Postgres tests, with `inList([])`, `notIn([])`, `has` / `none` / `every`, null ordering, and literal escaping.

- `tasks.pending().ownedBy(userId).find({ limit: 20 })`: a preset is a method on the table handle that returns the handle, so calls chain. They apply to `find`, `one`, `count`, `exists`, `aggregate` and `page`, and narrow the rows `update`, `delete`, `archive` and `restore` act on, including each item of a list `update`. `insert` ignores them. The planner writes the tenant predicate, the active set, the caller's `where`, then each preset's predicates, joined with AND, so a preset cannot remove the tenant predicate or reach an archived row.
- A write through a preset still needs a `where` or `.all(reason)`. A preset does not stand in for one (OKM1102).
- `inspect()` lists one `preset` line per call with the preset name, the fields it filters, who defined it (`table tasks` or `trait flagged`) and the source location. Values stay parameters in `sql()`.
- A preset name that is a client method or reserved fails with OKM1040 in `trait()` when the trait is built and in `connect()` before the first query. A preset that does not return its builder is OKM1121 when the call is planned.
- `registerPresets()` in `okmodel/safety` registers the rule that a preset adds predicates and never removes or replaces one. A property test composes random chains over a tenant table and checks the statement text and the rows on every read and write.
- `db.tx(fn)` and `db.tx({ isolation, retry, timeout, signal }, fn)` run `fn` in a transaction on one reserved connection. The callback gets a client `t` with the same tables, presets, tenancy, and archive handling. The call commits when `fn` resolves and rolls back when it throws. It exists on drivers with `transactions: "interactive"`; on any other it is OKM1111. `timeout` is milliseconds and covers the whole transaction, retries included.
- A nested `tx()` is a savepoint on the same connection. It refuses options (OKM1121). If the callback swallows a statement error, the transaction fails with that error instead of committing: Postgres would turn the COMMIT into a silent ROLLBACK.
- `retry` runs the callback again, in a fresh transaction, after a serialization failure or a deadlock. `outcome_unknown` and `cancelled` are never retried. The `timeout` is one deadline for all attempts.
- `db.batch([...])` runs writes as one atomic unit on every driver, with results in order. A failure carries `batchIndex`, or `null` at commit. Inside `tx()` it is a savepoint, so the transaction survives a failure. `.replica()` is OKM1840 and a read in the list is OKM1121.
- `t.afterCommit(fn)` runs after the outermost commit, in order, and never on rollback. An error in one goes to `hookm.onError` and never changes the result.
- `find({ lock: "update" | "share", wait: "nowait" | "skip" })` inside `tx()` appends `FOR UPDATE` or `FOR SHARE`, with `NOWAIT` or `SKIP LOCKED`. Outside `tx()` it is OKM1830. `t.advisoryLock(key)` takes a transaction-level advisory lock; a string is hashed.
- Every read and write takes `{ signal, timeout }`. An abort cancels the statement where the driver can and fails as `cancelled`; a timeout fails as `timeout`. Cancelling inside `tx()` rolls it back. `connect({ timeouts })` sets `acquire`, `statement`, `transaction`, and `idleInTransaction` in milliseconds.
- `connect({ hookm })` takes observers. `onNotice` hears server notices, `onTransaction` hears `start`, `commit`, and `rollback` (savepoints at depth 1 and up), and `onError` hears errors with no caller. An error a hook throws is dropped.
- `tx`, `batch`, and locks load on first use. A program that calls none of them pays 215 bytes minified and 225 gzip at startup.

#### tooling

- `engines.node` is `>=22`. The checks that can run do so on Node, Bun, and Deno, and the runtime entry is imported as an edge bundle. A runtime that cannot run a check prints the reason.
- `okm check` reports OKM1030 when a field has rules on the column and in the table `validate` section, or when `validation.style` disagrees with where the rules sit.
- `okm check` reports OKM1201 when the schema would validate and the project never imports `okmodel/validate`.
- The 200-table query probe has gated rows for a project with `okmodel/validate` imported and for one that uses `page`, `aggregate`, and `manyThrough`, each at its measured value plus 3 percent (D176). `scripts/app-relations.ts` is a reported app that uses those features.
- `startCutProxy` in `@okmodel/harness` cuts the next COMMIT on a TCP connection, and `registerTxSuite` runs one conformance suite of 38 cases on postgres.js, PGlite, node-postgres, and Bun.sql: serializable conflict and retry, a real deadlock, `skip` and `nowait`, timeout and abort kills, a cut commit and a cut batch, pool reuse with no leaked state, and savepoints. A driver that cannot do a case shows it as a skip with the reason.
- The 200-table query probe has two more gated rows, `query-200+presets` (19,180 / 7,128, ceilings 19,755 / 7,341) and `query-200+tx` (24,283 / 6,948, ceilings 25,011 / 7,156), each at the measured size plus 3 percent (D176).
- The 0.2 gate runs four property tests on real Postgres with a fixed seed (`OKM_PROPERTY_SEED`, default 20261005) that is printed on failure: `isolation.property` (random compositions of tenancy, traits, presets, relations, `include`, `aggregate`, `page`, writes, `archive`, `restore`, `batch` and `tx` with savepoints and retry, over two tenants with colliding keys, a one-connection pool and a concurrent run), `safety.property` (every safety rule registered together), `statements.shape` (the statement count depends on the shape of the call and never on 0, 1, 10 or 1,000 rows), and `archive.correctness` (archive, restore, cascade, partial uniques and `archiveId` against a model, inside `tx`, savepoints and `batch`). Each is shown to fail when a predicate is dropped on the wire.
- `scripts/app-full.ts` is a reported app with tenancy, `archivable()`, `timestamps()`, validation, relations, presets, `tx` and `batch` together. The size script prints it beside the plain app. It is not a gate.
- `batch-refusals.test.ts` runs every write kind in a batch, shows a blocked restore and a wrong `expect` refused with nothing written, and shows both still work in `tx()`. `snapshot-reads.test.ts` shows every read shape is one statement inside `tx({ isolation: "read committed" })` and that a reader never sees half of a committed write. `raw-sql-paths.test.ts` fails when the client or a table gains a method that could take SQL text, or when the runtime layer starts to read the `sql` template. `codes-not-reached.test.ts` records that OKM1110, OKM1191 and OKM1702 are registered and not thrown in 0.2.

#### docs

- The README lists the key options. The quickstart stays on `t.identity()`. Schema says how ids are generated and how to change the default.
- The roadmap is a public board. Each release is a milestone, and a pull request ends with `Closes #N`.
- The README shows a jsonb `contains` filter and an array update with `arr.append`.
- The size page records the no-trait startup graph at 83,043 minified bytes and 27,666 gzip. The gates stay. An application that uses `timestamps()` measures 85,744 / 28,503, and that figure is not a gate.
- Spec section 9 uses `columnTenancy` and `global("reason")`. The size page records the no-tenancy app at 85,356 / 28,361. The gates are that measurement plus 3 percent (D160). Column tenancy measures 91,802 / 30,411 and is not a gate. The 91,000 / 30,000 cap stays.
- D170 accepts the featureless app at 87,148 / 28,938. The gates, the cap, and the 7,100 type probe stay. An application that uses `archivable()` measures 95,725 / 31,604 at startup and is not a gate. A unique a trait adds after the tenancy rewrite is still not widened.
- Validation is opt-in. OKM1030 is reported by `okm check`, not while `schema()` compiles. D172 records why the first build was rejected and where the engine lives.
- D174 moves the missing-import check to the first write. The typed surface arrives in P27 as a module augmentation in `okmodel/validate`.
- Spec sections 6.2, 10 and 12 describe `manyThrough`, `page`, `aggregate`, and the decode rule. `iStartsWith`, `iContains`, and `iEndsWith` are not in 0.2 (D176); use `ilike()` with an escaped pattern.
- Spec section 6.2.1 describes presets: order of predicates, which calls they reach, names, inspection, and the OKM1040 and OKM1121 cases. D180 records the P28 size and the choices made. Presets are out of the known limits.
- D176 records the first P27 build (+1,425 / +431 over the stop line), the one redesign in which the relation carries its own emitter, and the probe policy.
- Spec section 15 gives `timeout` in milliseconds and says a nested `tx()` takes no options. D181 records the P29 numbers and the choices.
- 0.2.0 "Safety" adds tagged operators, final safety verification, field exposure (`.hidden()`, `.guarded()`, `.sensitive()`), column tenancy, the `timestamps()` and `archivable()` traits with cascade to direct children, validation, `one`, `many` and `manyThrough` relations with `include`, `page` and `aggregate`, presets, `tx` with savepoints and retry, `batch`, row locks, advisory locks, and per-call `{ signal, timeout }`. Its limits are in `docs/known-limits.md`: a unique added by a trait after the tenancy rewrite is not widened; archive cascades to direct children only; `sum` and `avg` over a `text` column, and over a `bigint` read as `bigint`, are OKM1124; `iStartsWith`, `iContains` and `iEndsWith` are not in 0.2; a mixed-sign `interval`, a non-default `IntervalStyle` and a seconds offset on `timetz` are OKM1210 on read; `onRead` is stored and not applied; there is no JSON Schema export; `rls` tenancy is not built; on PGlite and Bun.sql a `tx` timeout or signal cannot kill a statement waiting on a lock; Bun.sql has no notices; batch-mode drivers (Neon, D1) have no adapter; `idleInTransaction` is a client-side timer; a table named `tx` or `batch` is shadowed; and an option or builder that is not in 0.2 throws OKM1061 and names its version. `restore` and any write with `expect` are not allowed in `batch` (OKM1121); use `tx()`.
- The known-limits page is rewritten in groups and says what happens for each limit. The size page and the README carry the feature-full app (113,705 / 37,506 at startup) and what the entry-chunk size pass could save (at most 31,173 / 11,081 on the plain app, not built).

### 💥 Breaking Changes

- `import { json }` is the write namespace (`json.set`). A json column is `t.json()`.

### ♻️ Changed

- A push to main runs check and attest. The Postgres suite and the tarball job stay on pull requests, the release workflow, and the weekly run.
- A declared server below 18 that uses `uuidv7()` fails with OKM1812, and the message names `defaults.id`.
- `okmodel/pg/pg` and `okmodel/pg/bun` connect entries are gated at the measured size plus 3 percent (D156).
- `t.id()` and `t.identity()` stay omitted from insert and update. A plain primary key is writable on insert and omitted from update. Changing it is OKM1190.
- A postgres.js pool opened with TLS still lingers about 30 s after the last query on Node and Bun. A plain pool exits on its own. `close()` or `await using` releases it.
- A release checks the tag, packs one tarball, tests that file on Postgres, and publishes that same file. The GitHub Release closes the milestone.
- The npm description is one sentence.
- App startup is gated at 85,100 minified and 28,000 gzip (D158). postgres.js connect is 40,800 / 14,100, `pg` is 41,000 / 14,250, and Bun.sql is 39,800 / 13,800. PGlite stays 38,146 / 13,505.
- Synchronous `filters()` takes the app startup graph to 84,907 / 28,017, past the gzip gate. The gates move to measured plus 3 percent (D160): app startup 87,454 / 28,857, postgres.js 41,519 / 14,352, PGlite 38,620 / 13,613, `pg` 41,677 / 14,543, and Bun.sql 40,545 / 14,096. The 91,000 / 30,000 cap stays.
- `filters()` returns the parser directly. The promise is on `parse()`, which is what a request handler awaits.
- A signal or timeout, a watched query, checkout, listen, stream, the server-version query, and the fix text for write and include errors load on first use. Error codes, messages, SQL, and catalog output stay the same. The no-trait startup graph goes from 85,568 / 28,329 to 83,043 / 27,666. The gates stay.
- P24 takes the no-tenancy app from 83,043 / 27,666 to 85,356 / 28,361. The gates move to measured plus 3 percent (D160): app startup 87,900 / 29,210, postgres.js 40,200 / 14,090, PGlite 37,800 / 13,450, `pg` 40,900 / 14,410, and Bun.sql 39,700 / 13,940. The 91,000 / 30,000 cap stays.
- P27 takes the no-tenancy app from 87,408 / 29,001 to 88,278 / 29,326. The gates move to measured plus 3 percent (D160), capped at 91,000 / 30,000: app startup 90,900 / 30,000, postgres.js 41,600 / 14,600, PGlite 39,300 / 13,980, `pg` 42,400 / 14,920, Bun.sql 41,200 / 14,470.
- P28 takes the no-tenancy app from 88,393 / 29,385 to 88,723 / 29,553 (+330 / +168), inside the stop line of +600 / +180. No gate or ceiling moves. `query-200` measures 17,062 / 6,259 (+143 / +40 over P27b) under 17,300 / 7,100.
- A `ReadBuild` receives the call it builds for, so `aggregate` writes the `where` of the call after presets were applied and not the one it was created with. The planner reads `ruleLines` for the archive set and for presets.
- `sum` and `avg` over a field typed `number` or `string` pass the types, and the result has the type of the field. A `bigint` field typed `bigint` is OKM1124.
- OKM1130 also covers a cursor that `page()` did not return.
- P27b takes the no-tenancy app from 88,278 / 29,325 to 88,393 / 29,385 (+115 / +60). No gate or ceiling moves. The gated 200-table probes do not move; `query-200-validate` is 24,888 (+3).
- In a `where`, a bare object is OKM1121 for every column and `eq(value)` is the equality form for any object value (Temporal, arrays, ranges, json). The comparison operators and `not` take the codec's objects as operands.
- P29 takes the no-tenancy app from 88,723 / 29,553 to 88,938 / 29,778 (+215 / +225), inside the stop line of +1,400 / +400. No gate or existing ceiling moves. `query-200` is 17,078 / 6,271 (was 17,062 / 6,259).
- A table named `tx` or `batch` is shadowed by the client method.
- `withTenantScope` is removed from `src/runtime/plan.ts`. Nothing called it since `withRowFilters` took its place. No behaviour changes.

### 🐛 Fixed

- `batch` refuses a `restore` and any write that carries `expect` with OKM1121, before any statement is sent, on every driver. Both are checked against the result of their statement, and a batch used to report that after it had committed, leaving its other writes in place (D183). The error names `tx()`.

- A read of an `interval` or `timetz` column no longer fails with OKM1210. `interval` decodes what Postgres sends (`01:30:00`, `1 year 2 mons 3 days 04:05:06.5`, `-2 days`) and an ISO-8601 duration. `timetz` decodes `01:02:03+03` and `±HH:MM`, and the offset is `±HH:MM`. A negative `Temporal.Duration` is written with a sign on each field because Postgres refuses a leading minus (D179). An interval that mixes signs and a `sql_standard` or `postgres_verbose` `IntervalStyle` stay in the known limits.
- `insert` and `update` `set` refused every object value with OKM1121, including the Temporal values of the default `timestamptz`, `timestamp`, `date`, `time` and `interval` codecs, json and jsonb values, arrays, bytes, ranges and points. A column now takes the objects its codec declares and OKM1121 stays for any other object, so an operator-looking object never reaches a scalar column. A `Date` is not an input of any default codec and is still refused.
- A range object without `empty` is OKM1210 before any statement. It was sent to the database as a malformed literal.
- `eq()`, `lt`, `gt`, `between`, `inList` and `not` on a Temporal, array, range or json column failed with OKM1121 for the same reason.
- `insert([...])` typed every key as required on each row, though the runtime already filled an omitted key with `DEFAULT` per row. Rows in one list may now omit different optional keys or pass `undefined`; `null` stays NULL.
- postgres.js crashed with an uncaught `socket.write` when a reserved connection was used after its socket closed, and put a closed connection back in its pool on `release()`.
- node-postgres raised an unhandled `error` event when a checked-out client lost its socket, and returned that client to the pool.
- Bun.sql parked a reserved connection that had been lost.

## v0.1.1 — 2026-10-03

### ✨ Added

- The published README is the newcomer page: install, a default-exported schema, `okm push`, then `okm generate` and `okm migrate apply`, a shared client, insert, find with an include, and `safe` / `OkmError`.
- `bun run check` fails when `README.md` contains a relative link or an image.
- `bun run verify` runs the Postgres suite against Docker on this machine. One version by default (`POSTGRES_VERSION`, or 17). `--all` runs every supported major. CI stays the authority for a release.
- A connected client implements `Symbol.asyncDispose` when the runtime has it, so `await using` closes the pool. `close()` can be called again.

### ♻️ Changed

#### tooling

- The quickstart test runs `okm push`, and `okm generate` followed by `okm migrate apply`, against Postgres in the postgres job.
- The Release workflow publishes only from the tag `v` plus the `package.json` version, and the message names that tag when it refuses.
- Supported Postgres majors are 15, 16, 17, and 18. 13 is past end of life, 14 ends in November 2026, and 15 is the floor. A pull request runs the suite on 15 and 18 and the tarball job on 18. The release and a weekly run cover every supported major for both, and the release waits for that matrix and for a fresh install of the packed tarball. A file that cannot run on the topology is named, with the reason, in one list.
- CI runs on a pull request and on a push to main, so a pushed branch with a pull request runs once. A newer run cancels the older one on the same ref.
- The topology no longer rewrites passwords for Postgres 13. Replication still uses scram-sha-256, the server default from Postgres 14 on.
- After publish, a smoke install of that version from npm runs the quickstart against Postgres and fails when the version or its provenance is missing. The GitHub Release notes are the matching changelog section. Third-party actions are pinned by commit SHA, and two releases cannot run at the same time.
- npm metadata now has a description, keywords, a homepage, and a bugs URL.
- A pull request that cuts one bare version to the next, with the notes under the new `## vX.Y.Z` heading, is accepted with an empty Unreleased section.

#### docs

- The README and the package description say okmodel is catalog-first and PostgreSQL first, that version 0.1 supports PostgreSQL only, and that the schema is the single source for migrations and queries. A table of contents and a 0.1–0.5 roadmap replace the limits table. Size keeps the runtime entry, app startup, and cold import.

### 🐛 Fixed

- `find` with a to-one `include` returned null for the related row when that table had no primary key. The first projected column is the presence check in that case.
- Identity columns failed in `okm push` and `okm generate` and are fixed.
- A script that never calls `close()` exits after its last query. A plain postgres.js pool unrefs its sockets and does not start the idle timer. A process that stays up keeps its connections. A pool opened with `ssl` still uses the driver's socket and the 30 second idle timer.

## v0.1.0 — 2026-10-03

### ✨ Added

#### contracts

- `sha256` is a pure-TypeScript SHA-256 in the contracts layer. Fixture hashes use it.
- Catalog objects share one envelope: kind, identity, owner, definition, dependencies, and provenance. Tables, columns, indexes, constraints, sequences, and enum types are built here. Views, functions, triggers, extensions, roles, grants, and default privileges use the same envelope.
- An enum is a catalog object of kind `type`. Identity is `(namespace, name)`. The definition is the ordered label list, and that order is part of the catalog hash. Each column that uses the enum depends on the type.
- Constraint and index names are generated from a stable key. A name past the dialect limit keeps a SHA-256 suffix. Renaming a field does not rename those constraints or indexes.
- A catalog serialises to canonical JSON with a version field. The hash is SHA-256 of that JSON, so the same catalog yields the same bytes on every runtime. Namespace templates stay templates. The hash and the serialised text are computed on first use.
- `loadTrustedCatalog` checks the stored hash and version, then trusts the objects. It does not rebuild the catalog. `parseCatalog` stays the validating read.
- A declared rename rewrites identifier references inside check expressions, index predicates, and generated expressions. String literals stay as written. Constraint and index names stay.
- The driver contract is types only: `open` returns a pool with `execute`, atomic `batch`, `reserve`, `stats`, and `close`. Optional `stream`, `describe`, `listen`, and `cancel` follow capability flags. `DriverError` carries the server fields, `kind` (`timeout`, `cancelled`, or `outcome_unknown`), and `batchIndex` (`null` when the failure is the commit).
- `OkmError` carries `kind`, `category`, `summary`, `fields()`, `toHttp()`, `log()`, `retryable`, and `fix`. `safe()` returns `{ ok, value }` or `{ ok, error }`. `error.match` handles a category or `_`. `OkmError.is` narrows the kind and, for a registered table, the columns. Row values stay out of the error unless `includeValues` is set, and `log()` never prints them. `cancelled` is not retried. Every timeout is kind `timeout`. OKM1401 (`outcome_unknown`) is not retried and its fix says to check an idempotency key.
- `nearestName` suggests a close name for an unknown table, field, preset, or option. The error still lists the accepted values.

#### dialects

- `okmodel/pg` builds Postgres column types: keys, numbers, text, boolean, bytea, json, date and time, ranges, network, point and line, tsvector, ltree, enums, arrays, and `custom`. Each one compiles to a catalog column. `citext` and `ltree` record an extension dependency. `t.domain()` throws OKM1061 until 0.3.
- Codecs default to decimal strings for bigint and numeric, and to Temporal for timestamps. `t.bigint({ as: "number" })` and `t.numeric(p, s, { as: "number" })` override a field. `jsonReplacer` writes a bigint as a decimal string.
- `.picklist()` narrows a string column to a literal union and can add a CHECK. An empty list or a repeated value is OKM1060. A value outside the list is OKM1210.
- `enum` and `domain` are exported under those names. An invalid enum definition is OKM1060. `domain` throws OKM1061 and names 0.3. A label a codec rejects is OKM1210.
- Date and time codecs read the `Temporal` global. okmodel does not ship a polyfill. A missing global is OKM1210 and the message says to assign one to `globalThis.Temporal`.
- `table()` and `schema()` compile columns, references, indexes, checks, and unique constraints into a catalog. `one()` and `many()` declare relations. `manyThrough` throws OKM1061 and names 0.2. `morph` stays OKM1061 and says later. Options that arrive later throw OKM1061 and name the version (0.2, 0.3, or 0.4), or say later when no version is assigned. `schema()` defers the catalog document until `.catalog` is read.
- Postgres introspection builds a catalog from a schema. Copied partition primary keys and inherited indexes are left out. Check expressions and index predicates come back as the database's text. Enum labels are read from `pg_enum`, and a column of that type depends on it.
- `schema()` stores one type object per enum name. Columns that share the name share the object. Two different label lists for one name are OKM1020.
- The same DDL renderer plans a migration and builds a scratch schema, so a statement has one spelling.
- Tagged operators are one function per operator (`eq`, `lt`, `inList`, `or`, and the rest). An app that imports `eq` does not ship the others.
- `inc` adds to a numeric column in an `update` `set`. JSON and array operators are not in this version.
- `mapPostgresError` turns a `DriverError` into an `OkmError`. SQLSTATE picks the kind. A catalog constraint name (`{table}_{nameKey}_key`, `_fkey`, `_check`, or `{table}_pkey`) picks the column reason. `57014` without a caller abort is `timeout`.
- `Row`, `Insert`, and `Update` read a `Register` schema. `emitRowTypes` writes the same shapes (`Tasks`, `TasksInsert`, `TasksUpdate`). `schema({ types })` records `emitted` or `inferred`.

#### adapters

- `okmodel/pg/postgresjs` and `okmodel/pg/pglite` are separate entries. postgres.js and PGlite are optional peers, not dependencies of the core. One pool per endpoint. PGlite is a pool of one. Acquire timeout is OKM1846. Release runs `RESET ALL` and `pg_advisory_unlock_all()`. A timeout stays kind `timeout`. An abort from `signal` is `cancelled`. A commit whose connection dies first is kind `outcome_unknown` on `DriverError`, not an `OkmError`.
- Capability flags are readable per driver. `stream` on a driver that does not have it is OKM1111.
- `prepared: "named"` is not for transaction-mode poolers.

#### runtime

- `connect` from `okmodel/pg/postgresjs` and `okmodel/pg/pglite` returns a client typed by the schema passed in. postgres.js connects synchronously and the first query waits for the dialect check. PGlite connects asynchronously.
- Reads are `find`, `one`, `count`, and `exists`, with `where`, `select`, `orderBy`, `limit`, and `include`. A find needs a limit (OKM1101). A to-many include needs a limit (OKM1105). Includes are one LATERAL statement. `one` and `many` resolve through catalog foreign keys.
- `inspect`, `sql`, and `safe` report the plan, the statement, and `{ ok, value }` or `{ ok, error }`. Plans are cached by shape (FNV-1a, 64 entries). One endpoint until topology arrives. `stream` on a driver without it is OKM1111.
- SQLSTATE mapping and driver errors load on the first failure. The include planner loads on the first include. Checkout, describe, and stream load on first use. A successful find does not pay for them.
- Named prepared statements are opt-in (`prepared: "named"`). On a direct connection they were about 40 percent faster at p50 than unnamed. Unnamed stays the default. `prepared: "named"` is not for transaction-mode poolers.
- `insert`, `update`, and `delete` write rows. Unknown insert keys are dropped. A guarded field is OKM1190. A missing `where` is OKM1102 unless `.all(reason)`. `onConflict` is `"error"`, `"ignore"`, an update of named columns, or `{ on, return: true }`. `on` must name a unique constraint or the primary key (OKM1104). `expect` throws `not_found` when the count differs. Inserts chunk at 2048 parameters and commit together. A connection lost at commit is OKM1401 (`outcome_unknown`).
- Write planning loads on the first write. Conflict and upsert SQL loads only when `onConflict` is used. A plain insert does not load it. Hover on a row shows the field names and value types.
- `connect` reads the catalog hash from `okm_meta` in the same dialect query. Matching hashes return immediately. A database with no `okm_meta` skips the check. `connect({ requireMeta: true })` makes that missing hash OKM1520. The target name and `NODE_ENV` do not turn it on. Ahead by an expand migration is allowed. Ahead by a contract migration, or behind the code, fails with OKM1520. `loadTrustedCatalog` runs only on that mismatch, and only when `.okm/catalog.json` is present. `errors.http` is the default for `toHttp()` on errors thrown from the client. `toHttp(statuses)` replaces that default for one call.

#### tooling

- `okmodel/migrate` plans migrations. `defineConfig` lives on that entry. `okm build` validates the schema and writes `.okm/` (catalog, hash, emitted row types, and the table-name union for `references`). `okm generate` writes SQL only. `okm migrate plan <name>` prints the plan and its class. `okm check` reports a stale `renamedFrom` and a table file the schema does not import (OKM1024). Enum labels live in the catalog, not in a side file.
- An unexplained drop-and-add is OKM1530. The fix shows the line to add. The planner does not prompt.
- Removing a picklist or enum value needs `--replace table.column.old=new` (or `=null`). Without it, OKM1541's fix names the flag. The plan's expand step updates rows and keeps the old constraint; the contract step sweeps and swaps the constraint (`NOT VALID`, then `VALIDATE`). An enum removal recreates the type after that sweep: rename, `CREATE TYPE … AS ENUM`, `ALTER COLUMN … TYPE … USING`, then `DROP TYPE`. Adding a label is `ALTER TYPE … ADD VALUE`, marked non-transactional. `CREATE TYPE` is planned before the table. The type is dropped after the last column that uses it. Those data steps are plain statements. Batching them is later.
- `okmodel/testing` is reserved for 0.4 and is not an export in 0.1.
- `okm --version` and `okmodel --version` print the package version.
- Repository checks for layer imports, core purity, docs links and decision numbers, publint, arethetypeswrong, a `dist/` size ceiling, and bundle purity.
- `bun run bump next` moves the version to `<next release>-next.N` and leaves the changelog in place. `bun run bump release` drops that suffix and promotes Unreleased.
- Pull requests fail when the package version still matches the base branch, or when Unreleased gained no notes. A release that promotes Unreleased is allowed.
- `bun run db:up` and `bun run db:down` start and stop a Postgres primary with two streaming replicas. `POSTGRES_VERSION` selects 15 through 18.
- Tests can open an isolated PGlite database or a connection to that topology. They skip when Docker or Postgres is down, and fail when `REQUIRE_DOCKER=1`.
- Replay on either replica can be paused and resumed, and tests can read the primary insert LSN and a replica's replay LSN.
- A seeded generator builds schema fixtures of 10, 50, 200, and 500 tables, including a tenant-column variant, as a neutral description and Postgres DDL.
- Type correctness uses `expect-type` in `*.test-d.ts` files compiled by the TypeScript 7 typecheck. A wrong assertion stays in a fixture, and a test shows that `tsc` rejects it.
- `bun run type-cost` reads `tsc --extendedDiagnostics` and fails when an inferred 200-table type, the per-table rate, the emitted consumer, the tagged-operator surcharge, or the column sample exceeds its D133 ceiling. The gate compiles those fixtures against the built declarations. The source compilation is printed and is not gated, except the tagged-operator surcharge, which stays on the source number.
- `@ark/attest` runs on TypeScript 6 in its own CI job. It is not part of `bun run check`.
- `bun run bench` writes timings as JSON. Baselines can be stored beside the script; nothing compares them yet.
- `bun run catalog-bench` times canonical form, SHA-256, and topological order on the 200-table fixture. It prints the sample and does not enforce a ceiling.
- The replication test waits up to 30 seconds, matching its replay wait, so other Postgres tests can run beside it.
- The runtime-entry size gate is the measurement plus 10 percent: 6,100 minified bytes and 2,250 gzip (D144). A cold import on Node is the median of five fresh processes. CI fails above 25 ms (D134). Locally the script prints the 15 ms reference and records a finding above it.
- The 0.1 app startup budget is the startup graph after the trim: 77,524 minified bytes and 25,641 gzip, gate 79,849 / 26,410 (measured plus 3 percent, under the 86,688 / 27,800 cap). The total graph is printed and not gated. `okmodel/pg` is printed and not gated; a per-export tree-shake test and the app fixture are the gates. Connect entries stay gated on bytes (postgres.js 39,849 / 13,815, PGlite 38,146 / 13,505, measured plus 5 percent). Their cold import is printed, including a driver-stubbed sample, and is not gated. The 15 ms local reference applies to our own code with the driver stubbed. Adapter entries are gated on minified bytes that are not already in the runtime entry (postgres.js 15,093, PGlite 12,010). The app fixture's cold import is printed and is not the 25 ms CI failure. That failure stays on the runtime entry (D134), because the app runs `schema()` at import. Public subpaths are `okmodel`, `okmodel/pg`, `okmodel/pg/postgresjs`, `okmodel/pg/pglite`, `okmodel/migrate`, and `okmodel/internal`. `okmodel/testing` is reserved until 0.4 and is not exported.
- `bun run editor-check` compares hover, completions, and diagnostics from the TypeScript 6 language server with a snapshot. It also checks the row types `okm build` emits, including an enum column. TypeScript 7 has no language server, so the server is the dev-only `typescript-editor` package. It is not imported and not bundled. The check is part of `bun run check`.
- The Postgres CI job also runs the read and write tests.
- `bun run type-cost` also typechecks a find with filter, select, include, and orderBy on 10, 50, and 200 tables, against the built declarations. Instantiations stay under the D133 inferred-200 ceiling. The composite probe's own types ceiling is 7,100 (D140). The emitted-consumer measurement typechecks the row types `okm build` writes.
- `bun run bundle-purity` fails when a runtime bundle contains an npm package, or when `src/` imports the harness barrel. Adapter entries must leave `postgres` and `@electric-sql/pglite` external.
- A conformance suite runs the same driver cases on either adapter: execute, nulls, timestamps, numeric, bigint, json, arrays, batch (including a savepoint inside a reserved transaction), reservation, stats, close, and session reset. Cancel, timeout, and stream run only when the adapter declares them.
- Error-mapping conformance runs on postgres.js and PGlite: unique, not-null, check, foreign key, exclusion, serialization, deadlock, lock timeout, statement timeout, cancelled, connection failure, and `batchIndex` (a number, or null at commit).
- The error registry lists every spec §21 code (`code`, `title`, `summary`, `fix`) for `okm doctor`. It is not imported by the runtime entry. OKM1111 is listed for a call the driver cannot do.
- `bun run driver-bench` times `execute` against calling postgres.js directly. It prints the median and does not enforce a ceiling.
- The Postgres CI job runs the driver conformance suite with `REQUIRE_DOCKER=1`.
- `okm migrate apply` runs each migration in one transaction where Postgres allows it. `CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, and `VACUUM` are their own steps. Every finished step writes a checkpoint in `okm_history`, with the catalog hash. A failure stops at that step and the next apply resumes. There are no down migrations. A data step runs as the statement the plan wrote.
- One session advisory lock covers the apply. A second apply fails at once with OKM1522. `lock_timeout` and `statement_timeout` are set on every step, and a lock timeout retries with backoff.
- A known pooler URL is refused unless `--allow-pooler` or `allowPooler` is set.
- Named `targets`. More than one requires `--target` (OKM1853). Two names for one database must agree on protection (OKM1852).
- A protected target allows read-only commands and expand. Contract, unclassified, push, backfill, seed, and history repair need `--allow-protected`. Drop and rollback stay refused. `push` is refused only when the target sets `protected`. A target named `production` is not special; production targets must set `protected`.
- `okm migrate status` reports each target's version, catalog hash, state (current, behind by expand, behind by contract, ahead, failed at a step), and whether it is protected.
- `okm push` applies the current plan as a prototype sync. `okm dev` starts a local PGlite database in `.okm/dev-db` when no target named `dev` is configured.
- The Postgres CI job also runs the apply tests.
- An API snapshot fails CI when a public subpath gains or loses an export. Each export is classified stable, experimental, or internal.
- The per-export tree-shake check fails when one `okmodel/pg` export keeps an unrelated module.
- A quickstart test packs the tarball, installs it in a fresh project, and runs the commands in the quickstart doc: `okm build`, `okm generate`, and `okm migrate apply`, then the read and write calls.
- The compatibility table is generated from the conformance run on postgres.js and PGlite.

#### docs

- The M0 gate findings are in `docs/m0-findings.md`, with a Resolved by column for each row.
- Spec section 21 records OKM1026 for a catalog dependency cycle and OKM1027 for a catalog document this version cannot read.
- `docs/editor-check.md` describes the language-server snapshot for row hover, column completion, and a missing column or table, and the same check on emitted row types.
- The quickstart, production checklist, environment recipes, known limits, measured size, API classification, compatibility table, and the 0.1.0 release checklist.

### ♻️ Changed

#### contracts

- Catalog serialisation, parsing, hashing, rename, and dependency order are no longer on the runtime entry. They stay in the catalog document module for tooling.
- `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders move to `okmodel/internal`. `okmodel` keeps `OkmError`, `safe`, the row types, and the driver types. `table` and `index` for a schema are `okmodel/pg`.
- SHA-256 round constants and the reserved-word set are built on first use. UTF-8 length and encoding share one helper. An ordering pass computes each identity key once.
- Catalog errors name the accepted value.
- A foreign key whose column type does not match its target is OKM1022. Foreign keys store `onDelete` and `onUpdate`.
- A table or schema option that the types accept but this version does not implement is OKM1061. OKM1060 stays an invalid column definition.
- A catalog dependency cycle is OKM1026. A catalog document this version cannot read is OKM1027. OKM1020 stays the code for an unknown table.
- An invalid column definition is OKM1060. A value a codec rejects is OKM1210. Messages name the accepted values.

#### dialects

- `schema()` builds the query model immediately and defers catalog object construction until `.catalog` is read.

#### tooling

- Source layers use the folder names `contracts`, `dialects`, `adapters`, `runtime`, and `tooling`.
- `okmodel` and `okmodel/pg` are built with code splitting. A shared module, including the catalog identity, is emitted once. The bundle-purity check fails when a module is copied into two outputs.
- The published `dist/` is 146975 bytes after code splitting (it was 169519 when each entry inlined the catalog). The ceiling is 184000 bytes, that size plus 25%.
- D133 ratchets type cost to the declaration measurement plus 25 percent, raises the `dist/` ceiling to 241000 bytes, and gates the 10-table app bundle at 48000 bytes minified, 15800 gzip, and 15 ms cold import. The tagged-operator ceiling stays 800 on the source measurement. The cold-import sample is the median of five fresh Node processes.
- `schema()` compiles unique, index, and check options only when a table sets them, so startup does not compile those paths.
- A plain identity key is built without the general JSON encoder, and ASCII identifier lengths skip the UTF-8 walk, so schema startup compiles less.
- Lint and format use oxlint and oxfmt. Layer and purity checks read imports from the Oxc AST.
- Declaration emit no longer requires `isolatedDeclarations`, so exported types may be inferred.
- The published package sets `sideEffects` to false.
- The harness barrel no longer re-exports Postgres or PGlite.
- Postgres tests share one Docker skip rule.
- Cold import fails on CI above 25 ms (D134). A local sample above the 15 ms reference is printed as a finding and does not fail the script.
- The runtime-entry gate is measured plus 10 percent (6,100 minified bytes, 2,250 gzip). The 25 ms CI cold-import gate stays on that entry. App startup and connect gates stay.
- `dist/` size is reported and no longer fails the check (D135). `size-budget.json` is removed. Adapter entries are gated on minified bytes that are not already in the runtime entry, so shared code is not counted twice.

#### docs

- The package description names typed queries, safe migrations, and replica-aware routing. The README is the 0.1 install note.
- Changelog area headings are the layer names: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, and `docs`.
- Normative docs match spec draft 22 and decisions D1–D143. The spec lists builders and options that throw OKM1061, and it says a production target must set `protected`. The spec registry names OKM1026, OKM1027, OKM1060, OKM1061, and OKM1210.
- The quickstart test runs the commands in `docs/quickstart.md`, including `okm migrate apply`. Production and preview `apply` run in CI. Creating a preview database, seeding, deploying, deleting it, and cloning production for rehearsal do not: those steps are infrastructure, and CI has no production clone.
- `okmodel/internal` has no stability promise. The README and the known-limits page say so, and its exports are marked `@internal`.
- `docs/release.md` includes starting the Release workflow from the GitHub Actions page on the `v0.1.0` tag, next to the `gh` command.
- Engineering standards (D129) are in `AGENTS.md` and the ship skill. Reports state runtime entry size, cold import, and type-cost change.

### 🐛 Fixed

#### dialects

- `schema().catalog` accepts an enum column. It no longer raises OKM1020 because the enum type was missing from the catalog.

#### runtime

- Inside `insert({ ... })`, completions list the property under the cursor and every insertable column not already written. Optional columns are optional keys. A guarded column, or one insert omits, stays out. One row stays one row.

#### docs

- `docs/editor-check.md` records that insert completions include the unfilled insertable columns.

### 🔥 Removed

- The M0 spike implementations are deleted. They remain on the `m0-spikes` tag. Findings stay in `docs/`. The row-type and operator fixtures remain so the type ceilings can be measured.
- The empty `okmodel/testing` export. The name is reserved until 0.4.
- Internal helpers leave the public subpaths. `okmodel/pg` no longer exports `compileColumn`, `emitRowTypes`, `mapPostgresError`, or the operator tag helpers. `okmodel/migrate` exports `defineConfig`, `MigrateConfig`, and `TargetInput`. The CLI imports its helpers from the package.
