# Known limits

What this version does not do, or does differently from what you might expect. Each item says what happens, so none of them is a surprise at runtime. A limit that has a version is listed in the release train in [`okmodel-execution-plan.md`](okmodel-execution-plan.md). `later` means the plan has not assigned a 0.x release.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release. Its exports are marked `@internal`.

## Not built yet

An option or builder that is not in this version throws OKM1061 and names the prompt or version that adds it, or it is not a method yet. These are the ones the plan has assigned.

| Item | Version | Prompt |
| --- | --- | --- |
| `morph` | later | M2 |
| `computed` | later | no 0.x prompt |
| `policies` | later | no 0.x prompt |

`provision(target)` installs one configured target. Creating a schema per tenant, creating a database per tenant, and the tenant registry are M5. See [provisioning](provisioning.md).

Also not in this version:

- **Row-level security is M2.** `rls` tenancy is not built. Column tenancy is the only strategy. Inside `tx()` the tenant is the column predicate on every statement (D181).
- **Schema-per-tenant and database-per-tenant are M5.** `isolation()` checks column tenancy. A global table is skipped and listed. A factory row is the inserted record, not a generated row type.
- **`isolation()` checks tables only.** A view and a materialized view have no rows of their own to insert, so they are left out and not listed. A view over tenant tables that does not expose the tenant key is caught by `okm check` (OKM1820). A read-only isolation check for views is M2.
- **Three registered codes are not thrown in this version** (D183). OKM1110 (a feature needs a newer engine than `requires`): the one engine-dependent feature, `uuidv7()`, fails as OKM1812 when the schema is built with `requires` below 18, and `okm migrate apply` raises it before any statement when the server is older than 18 (D184). OKM1191 (no snapshot plan inside READ COMMITTED): every read is one statement, so a plan always exists. OKM1702 (unverifiable raw SQL on a tenant table): no public call takes raw SQL; typed raw SQL is M2.
- **`okm ext test` and `okm ext scaffold` are not built.** `okm ext list` prints the extensions the connected server can install and the version that is installed. `okm ext check` compares those versions with the schema. The conformance suite and the scaffold are later.
- **JSON Schema export is absent.** `insert` and `update` are Standard Schemas; they do not emit JSON Schema.
- **`onRead` is stored and not applied.** `validation: { onRead: true }` is accepted and read values are not validated.
- **`iStartsWith`, `iContains` and `iEndsWith` are not in this version** (D176). Use `ilike()` with an escaped pattern.
- **`aggregate()` has no `having` and no `bucket`** (M2).
- **A refused replica holds reads that are already queued on postgres.js.** A read queued behind a refused replica waits for postgres.js's reconnect backoff before it falls back to the primary. The backoff is shared per pool and capped at 20 seconds. Reads that start after the failure go to the primary at once. In one run of 20 concurrent reads with one refused replica, node-postgres and Bun.sql finished in about 0.1 to 0.2 seconds each, and postgres.js took up to 19.6 seconds (QA-M1, D214).
- **Batch-mode drivers have no adapter yet.** Neon HTTP and Cloudflare D1 are covered by the driver contract (`batch` is required on every driver) and there is no adapter in this repository for either.
- **`inspect()` does not show routing reasons.** It reports `single-endpoint`. Reasons go to `onRoute`, including `fallback:behind` and `fallback:saturated`. Showing them from `inspect()` is the M2 dev inspector. A string or pool client has no `using` and serves either `route` from its one endpoint. See [topology](topology.md).

## Topology

- **The watermark is client-wide.** The root, `for()`, `unscoped()`, `using()`, and `reserve()` share one commit position (D204). A write on any of them moves the watermark for the others. A watermark per `for()` client is deferred: the router cannot see which client issued the statement.
- **Statement class is the statement text.** A leading `select` is a read. That includes a `select` whose body calls `nextval`, and a view defined that way: `find` sends it to a replica, and the hot standby rejects it as read-only. The classifier stays text-based. Raw SQL in M2 needs an explicit class (D205).
- **A committed write costs one extra round trip** when replicas are configured and `consistency` is `"session"`. That read is `pg_current_wal_insert_lsn()` after the commit, and it finishes before the write's promise resolves. `"eventual"`, and a connect with no replicas, do not read it.
- **A position is not carried across processes.** A cookie or a header that would keep read-your-writes across servers stays deferred (spec section 25).

## Views

- **A view is SQL plus a declared column list.** `view()` and `materializedView()` live on `okmodel/view`. `db.views` keys are camelCased: `active_projects` is `db.views.activeProjects`. `db.views.<name>.find(...)` is read-only. Its type comes from `schema({ views })`: each field is the camel-cased column name, typed `string | null`, because every view column is read as text. A view that reads a tenant table and does not expose the tenant key is OKM1820 unless declared `global("reason")`. The query builder form (`view(name, (q) => q.from(...))`) is not in this version (D190).
- **A materialized view is refreshed with SQL.** `REFRESH MATERIALIZED VIEW "<schema>"."<name>"`. There is no `refresh()` handle. §5.7 does not define its arguments or return type, so 0.6 does not add one (D222).
- **Column dependencies come from `pg_depend`.** Scratch verification (`sealViews`) creates the view and reads those edges. A plan from two author catalogs does not see them until that read.
- **`okm check` reprints a view on the connected server before it compares.** `pg_get_viewdef` replaces the author text, so a spelling that server prints differently is not drift after push. A query that reprints to something else still is. Two introspections of the same view match. A plan between two author catalogs still compares the text that was written.
- **`refresh: "concurrently"` is not stored by Postgres.** Introspection leaves it unset. Equality ignores it, so a later plan does not recreate the materialized view only because the mode was declared. `REFRESH ... CONCURRENTLY` still needs a unique index (OKM1822). The plan's first populate is a plain `REFRESH`, because Postgres rejects `CONCURRENTLY` until the view has rows.
- **`security_invoker` is not set.** It belongs to the `rls` strategy, which is later.

## Functions and triggers

- **A typed call (`fn.slugify(col)` in a predicate, projection, or order) is not in this version.** `fn()` and `trigger()` are catalog objects. The planner does not compile a call fragment.
- **`timestamps()` installs a trigger only with `enforce: "trigger"`.** The client otherwise sets `updatedAt` to `now()` on update. The trigger is `<table>_touch` and the function is `okm_touch_<column>`, so a table named `lists` gets `lists_touch`. `archivable()` installs no trigger. `timestamps()` together with `archivable()` installs `lists_touch` only when `enforce` is `"trigger"` (QA-L13, D215).
- **`inspect()` does not list triggers.** `okm doctor` lists the triggers on each table. A code argument prints that code.
- **A plpgsql body is the source text.** Introspection reads `prosrc`. A round trip has no steps when the declared body is that text.
- **`LANGUAGE sql` with `BEGIN ATOMIC` stores the server reprint.** `prosrc` is empty, so the body is the `BEGIN ATOMIC` block from `pg_get_functiondef`. Dependencies are the `pg_depend` edges. Two introspections of the same function match. A plan from the live catalog back to the author text replaces the function when the reprint differs from the text that was declared. There is no warning. Write the body as that reprint.
- **A trigger `WHEN` is stored as written.** Introspection reads `pg_get_expr`. A predicate Postgres reprints differently is planned as a trigger change. A round trip has no steps when the stored text is already that printed form.

## Roles and grants

- **Fine-grained grants, including column-level grants, are M2.** `roles: { migration, app }` grants the application role a fixed set: `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on tables and views; `SELECT` on materialized views; `EXECUTE` on functions; `USAGE` and `SELECT` on sequences. Default privileges use that set, `FOR ROLE` the migration role, in the target schema. Privileges outside the set are not diffed.
- **A role is never dropped.** A plan creates a managed role when `pg_roles` does not have it (`CREATE ROLE` has no `IF NOT EXISTS`) and alters `LOGIN` and `INHERIT` in place. Roles belong to the cluster, so apply runs that `CREATE ROLE` in a `DO` block that ignores a role another database's apply created first. Two databases provisioned at once both apply. A password, `GRANT OPTION`, and any other attribute are not stored. A name in `roles` is external unless it is also listed in `managed`.
- **Two applies that alter the same role at once can fail.** When two databases on one cluster run the same `ALTER ROLE` step concurrently, Postgres fails the second with `tuple concurrently updated`. Run apply again. A provision from the head snapshot only creates roles, so parallel previews are not affected.
- **OKM1825 is `okm doctor` only.** `connect()` does not check the application role. Putting that check on `connect()` measured +2,690 minified bytes and +917 gzip on `okmodel/pg/postgresjs` (the same minified increase on the other connect entries) and +2,699 / +941 on the featureless app, which is past the budget. `okm_meta` is not a catalog object; when that table exists, `connect()` reads it, so the application role needs `SELECT` on it.
- **A function grant is `name(argTypes)`.** Argument types are joined without spaces. Introspection and `okm doctor` read `oidvectortypes(proargtypes)` with the spaces removed, so argument names are not part of the grant (D208).
- **Roles and grants are not in the startup hash** (D208). `connect()` compares the schema's catalog without them. A role or grant that drifted is found by `okm check` and `okm doctor`, not at startup.
- **Creating the migration role grants it the schema, then `SET ROLE`.** Those statements are runner actions, not plan steps. The role is `NOSUPERUSER NOCREATEDB NOCREATEROLE`. The schema grant is `USAGE` and `CREATE` on the schema the migration targets (`public` unless apply was given another). The same run grants that role `SELECT`, `INSERT`, and `UPDATE` on `okm_meta`, `okm_history`, and `okm_backfill` when this run created them as another role.

## Domains

- **The base type of a domain cannot change.** A plan that replaces `t.domain("pos", t.integer(), …)` with `t.domain("pos", t.text(), …)` fails with OKM1020 and names both types. The base stays as it was created. Add a new domain when the column needs another type.
- **An enum cannot be the base of a domain.** `t.domain("shade", t.enum("color", ["red"]), …)` is OKM1060. Use a scalar column type.
- **A domain check is stored as written.** Introspection reads the check Postgres prints (`pg_get_constraintdef`, with the leading `CHECK` removed). A difference that is only parentheses or casts is still a check change. `okm check` does not warn. Write the check the way Postgres prints it, for example `((VALUE > 0))`.

## Safety and tenancy

- **A hidden column can be named in `where` and `orderBy`.** Default `select` and includes leave it out. Naming it in `select` returns it. `aggregate` `groupBy`, `sum`, `avg`, `min`, and `max` refuse it (OKM1120). `filters()` refuses it in an allowlist (OKM1123). Writes accept it and redact the error. This stays as it is until 0.6. The options are in D215 (QA-S1).
- **`filters().parse` applies thirteen operators.** `eq`, `in` (`inList`), `notIn`, `lt`, `lte`, `gt`, `gte`, `between`, `startsWith`, `endsWith`, `contains`, `like`, and `ilike`. An operator the allow type accepts and parse cannot apply is OKM1120 on `parse()`, not when `filters()` is called (QA-M9, D215).
- **A unique that a trait adds after the tenancy rewrite is not widened** (D168). `columnTenancy().rewrite()` runs first and widens uniques the table already declared. Trait `apply` runs after that, so a unique introduced by the trait stays on the trait's columns only. `timestamps()` adds no unique. `archivable()` adds no unique either: it turns uniques that already exist into partial unique indexes (`WHERE archived_at IS NULL`) after the rewrite, so a tenant unique stays `(tenant key, column)` with that predicate. The primary key stays a full constraint.
- **Archive cascades to direct children only.** `archivable({ cascade: ["projects"] })` archives the active projects of an archived org in the same statement, with the same `archiveId`. It does not archive the tasks of those projects. A grandchild stays active under an archived parent until you archive it, or until its own parent has `cascade` for it. Restore follows the same rule: it restores the children that share the row's `archiveId`.
- **A table named `tx` or `batch` is shadowed.** On the client, `db.tx` and `db.batch` are the methods. A table with either name is unreachable by that property; rename the table.

## Reads and types

- **`sum` and `avg` over a `text` column pass the types and fail when the call runs (OKM1124).** The row types cannot tell a `numeric` string from a `text` string.
- **`bigint` as `bigint` aggregates are refused (OKM1124).** `sum` and `avg` over a `bigint` column that reads as a JavaScript `bigint` do not run (the total has no honest `bigint` type). Map the column as a string or a number, or read the rows and add them in the application. `min` and `max` work.
- **Some intervals and times cannot be read.** An `interval` that mixes signs, such as `1 day -01:00:00`, cannot be one `Temporal.Duration`, so a read that selects it fails with OKM1210. The decoders take the default `IntervalStyle` (`postgres`) and ISO-8601; `sql_standard` and `postgres_verbose` output is not read, and that is OKM1210 too. A `timetz` with a seconds offset such as `+05:30:15` is OKM1210 (D179).
- **Finer than microseconds does not survive a write.** A value keeps microseconds (QA-L1). Digits past the sixth are rounded by Postgres on write: `2020-01-02T03:04:05.123456789Z` reads back as `.123457`. An explicit precision truncates client-side instead. Either way a read-back differs from the written value past microseconds, with no warning.

## Transactions, cancellation and batch

- **`idleInTransaction` is a client-side timer,** not the server's `idle_in_transaction_session_timeout`. The client fails the transaction when it has sat idle that long; the server setting is untouched.
- **On PGlite and Bun.sql a `tx` timeout or signal cannot kill a statement waiting on a lock.** The callback is released and the rollback queues behind the waiting statement. PGlite has one connection and no `cancel`; Bun.sql has no `cancel` on Bun 1.4 (D181).
- **On Bun.sql and PGlite a `timeout` or `signal` does not settle a call whose statement is already running (QA-M3, D216, D224).** Neither driver can cancel an in-flight statement (`cancel: false`), so the call settles when the statement ends: past the deadline, with the database's own error when one fires. The statements are not raced client-side. The fix grew Bun.sql by 108 / 39 and PGlite by 191 / 92. P81 does not rebuild it: Bun.sql must not grow, and PGlite blocks the JavaScript event loop, so a timer in the lazy watch chunk cannot beat a running statement. A call that is still queued, rather than running, keeps the existing behaviour: it is refused with kind `timeout` or `cancelled` before it starts.
- **On PGlite a call made on the outer client from inside a `tx()` callback queues behind the transaction (QA-M3, D216).** The transaction holds the single connection, so the outer call waits for the callback that waits for it. It is not refused: OKM1192 stays reserved for the refusal and is not thrown in this version. A call from unrelated code that merely runs while a transaction is open queues the same way. Use the client the callback received.
- **Bun.sql has no notices.** It does not surface `RAISE NOTICE`, so `hookm.onNotice` never fires on `okmodel/pg/bun`.
- **`restore` and any write with `expect` are not allowed in `batch`** (D183). Both are checked against the result of their statement, and a batch cannot report that after it commits. A batch that holds either is refused with OKM1121 before any statement is sent, with the error naming `tx()`. Use `tx()` for them. A statement the database refuses (a unique, a foreign key, a check) still rolls the whole batch back.
- **The types still accept `restore` and `expect` inside `batch`; only the runtime refuses them** (D184). Narrowing the types so the compiler refuses both was measured in 0.2.1 and not built: refusing the `{ expect }` option takes a second overload on every write method, which moved the `query-200-validate` probe from 25,047 to 27,366 instantiations against a ceiling of 25,631. A `restore` or a `.expect()` call on its own costs +2 / +1 on every probe; the option form is the part that does not fit.

## Drivers

A postgres.js pool opened with `ssl` still uses the driver's socket and its 30 s idle timer (D152). Measured on Postgres 17 with TLS 1.3, one query, and no `close()`: the process exited in 30.10 s on Bun and 30.07 s on Node 26. A plain pool (no `ssl`) exits on its own. `close()` or `await using` releases a TLS pool without waiting.

node-postgres sets `allowExitOnIdle` and `idleTimeoutMillis: 0`. A plain pool exits after the last query, and an idle connection stays open while the process is alive. The same unref applies to the TLS stream `pg` uses after the handshake. This tree has no TLS server, so that path is unread. `pg` cannot describe a statement without running it. That conformance case is skipped.

Bun.sql keeps `idleTimeout` at 0, which is Bun's default (no idle timer). A finished Bun script exits without `close()`. `Query.cancel()` does not abort the backend statement on Bun 1.4, and Bun.sql does not surface `RAISE NOTICE`. Those conformance cases are skipped. Bun.sql also cannot describe a statement without running it. `okmodel/pg/bun` loads only on Bun.

## Migrations

- **A volatile default is a batched backfill** (D193, D195). The planner adds the column nullable, sets the default, then fills existing rows with an idempotent `UPDATE` (`where` the column is null) in key-range batches. A removed picklist or enum value uses the same step (`where` the old value). A stable or constant default stays a plain `ADD COLUMN`. The step format, the pause, and resume are in [backfill](backfill.md).
- **A backfill does not iterate tenants.** Column tenancy is one pass over the whole table. Iterating tenants belongs to schema-per-tenant and database-per-tenant (M5).
- **The backfill checkpoint is on the target, not in a control database.** `okm_backfill` is created by apply. The control database in §19.5 arrives with the multi-target runner (M5).
- **On a protected target, a migration with a backfill stops after its expand steps.** `okm migrate apply` runs the steps before the backfill (adding the column and its default), then refuses the backfill with OKM1850. `okm migrate status` prints `failed at step N (resume with okm migrate apply)`. Running apply again with `--allow-protected` resumes at the backfill. Rehearse on a clone first (see [example app](example-app.md)).
- **There is no `okm backfill` command.** The step is in the migration file. `okm migrate apply` runs it.
- **A backfill does not store the row estimate.** `about N rows, about M batches` is plan output only (D194). Resume reads the last key in `okm_backfill`.
- **Row estimates are `pg_class.reltuples` on the selected target** (D194). `okm migrate plan` prints them when that target is reachable. It does not run `count(*)`. A table that has not been analyzed prints `rows unknown (table not analyzed)`. A table the target does not have yet prints `new table`. The number is only as fresh as the last analyze. A partitioned table, or a parent with inheritance children, is estimated from that relation's own `reltuples`, not by adding the children. Estimates are plan output only: the linter does not read them, and they are not written into SQL, catalog files, or `okm_history`. `okm generate` stays offline.
- **A declared table rename renames default names only** (D194). `renamedFrom` on a table plans `ALTER TABLE … RENAME TO`, then renames a primary key, unique or check constraint, foreign key, index, or identity sequence when its name is the default `{table}_…`. A custom name stays. An add and a drop with no declaration is OKM1530. The recreate check covers every object kind the planner handles; no generator shape was excluded.
- **The extra unique beside a tenant primary key is named from TypeScript fields** (D223). The name is `{table}_{primary fields joined by _}_{tenant field}_key`, for example `tasks_id_tenantId_key` on SQL columns `(id, tenant_id)`. A column `.unique()` is `{table}_{field}_key`. `renamedFrom` renames those constraints. It does not drop them. `archivable()` turns the unique into a partial index whose name uses SQL column names. The formula is unchanged, so existing catalogs do not move.
- **The linter does not connect, and it is not data-aware.** It reads the plan and the catalogs. An existing table is one present in the catalog before the plan. It cannot see how many rows are stored.
- **A type change that rewrites the table is not rewritten** (D193). OKM1538 stays a warning. There is no safe form in this version. A column swap is expand and contract work for a later step. OKM1524 already requires a reason for the type change.
- **OKM1706 and OKM1823 are not linter rules.** A tenant index that does not lead with the tenant key is OKM1706 when the schema is built. `security: "definer"` without `searchPath` is OKM1823 on `fn()`. Both fail at declaration time, which is stronger than a lint, and the linter does not copy them.
- **OKM1542 flags a data statement outside `backfill()`.** `insert`, `update`, `delete`, `merge`, `truncate`, and a `with` that writes, are errors. `DO` and `CALL` are errors too: the body is not analysed (D211). A backfill `update` is not. Reference rows are not migration steps, so they are not flagged. See [provisioning](provisioning.md).
- **`okm migrate check` does not check tenant targets.** Tenant targets and schema-per-tenant checking are M5. The command checks the selected target's history in one scratch schema.
- **The previous-catalog check is schema-level only.** It requires every table, column, constraint, and type from catalog N−1 to remain in N, with the same type, and it refuses a tighter nullability that has no default unless the migration's recomputed class is `contract`. It does not prove application behaviour.
- **Upgrade: an archivable unique index created before D208.** `archivable()` now writes the partial index predicate the way Postgres prints it, `(archived_at IS NULL)`. On a database created with the old text, after the upgrade `connect()` is OKM1520 ("behind the app") and `okm check` is OKM1510 with `OKM1529 creates a unique index`. Clear it with `okm generate archive_predicate`, add `-- okm-allow OKM1529: rebuilds the same index` above the `create unique index concurrently` line, then run `okm migrate apply`. The index is dropped and created again with the same definition. `okm migrate check` still fails with OKM1547 at the migration that first created the index, because that migration's stored catalog keeps the old text. It failed the same way before the upgrade. `lintFrom` does not change it: it only skips lint. No command rewrites a shipped migration.
- **Upgrade: a database applied with `roles` before D208.** It stores a hash that counted roles and grants, so after the upgrade `connect()` is OKM1520 until `okm migrate apply` runs once. That apply prints `restamped <migration id>` and needs `--allow-protected` on a protected target.
- **A migrate target cannot be a replica** (D201). `database` or `targets` that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845. The command does not resolve that URL. A string URL is still the primary.

## What works

`.hidden()` stays out of default selects and includes. `.sensitive()` redacts values in logs, errors, and `inspect()`. `one()`, `many()` and `manyThrough()` work; a relation value that is not one of those throws OKM1061.
