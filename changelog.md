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

### ♻️ Changed

- A pull request no longer runs the Postgres suite. The label `needs: postgres` runs the suite on 15 and 18 and the tarball on 18. `bun run verify` runs that suite on this machine. The release and the weekly run still cover 15 through 18 (D212).

### 🐛 Fixed

- `update`, `delete`, `archive`, and `restore` now refuse a where with no effective predicate, including undefined values (QA-C1, QA-H2). A field value is a leaf. `eq` keeps a timestamp, a date, bytes, or a jsonb object in the filter. A bare object stays OKM1121 (D125, D210).
- An `or()` branch with no effective predicate is now refused, in reads and in writes (QA-H1). `or([])` still matches nothing.
- `or()` with a non-array or with more than one argument is now refused (QA-M4).
- An unknown key on `update`, and `tx` with the function before the options, are now refused (QA-M2).
- A bad option on `find`, `one`, and `count` now rejects the query, so `safe` and `catch` see OKM1120 (QA-M11). `page` and `aggregate` already did.
- Compiled SQL for a tenant table keeps the tenant predicate on every table alias, including a where that compares an object through `eq` (QA-S4).
- A hand-written migration step is linted per statement. A leading comment, a second statement, a semicolon inside a comment, `DO` and `CALL`, and `ALTER COLUMN … TYPE` can now be refused (QA-H3). `-- okm-allow` on the step silences that code on every statement of the step.

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
