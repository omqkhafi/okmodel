# OKModel — API design (draft 26)

Status: design draft, 2026-09-30. Not yet approved for implementation. Draft 18 applied the M0 gate decisions D115–D127 (evidence: `docs/m0-findings.md` in the repository); draft 19 added D128 (catalog error codes); draft 20 added D130 (column definition and codec error codes); draft 21 added D131 (removing a picklist or enum value); draft 22 adds D132 (reserved options, reference names); draft 24 adds the 0.2 operator set (section 10.1); draft 26 takes the primary-key and Postgres 15 floor edits made in P17G (D148, D151) and renames the uuid default to `uuidv4` (D153). Draft 26 records the shipped id builder shape (P19, D153, D154) and the `defaults.id` fix text. Supersedes drafts 1–21 of this file and the API sections of `orm-research-design.md`. Evidence for the draft-4 changes is in `okmodel-gap-research.md`.

Name: **OKModel** (short **OKM**). Package `okmodel` on npm and repository `omqkhafi/okmodel`, CLI bins `okm` and `okmodel` (same program), error class `OkmError`, error codes `OKM1xxx`, config file `okm.config.ts`, generated folder `.okm/`, metadata table `okm_meta`. The bin names are not npm package names, so a bare `bunx okm` without a local or global install could fetch an unrelated package; the README tells developers to install first (`bun add -d okmodel`, then `bunx okm`, or a global install).

Toolchain: **TypeScript 7** (the native compiler, still invoked as `tsc`) for typecheck, declaration emit and editor support, with `strict` on. TypeScript 7.0 has no stable programmatic API (expected in 7.1), so no OKModel tool may depend on the TypeScript compiler API: `okm` reads user TypeScript by executing it through the runtime and emits source as text (`okm pull`). Type-level checks need no compiler API: type correctness is asserted with `expect-type` style assertions in `*.test-d.ts` files compiled by `tsc`, and type cost (instantiations, check time) is read from the compiler's own diagnostics by a script; a tool that does need the API, such as `@ark/attest`, may only run in a separate CI job on the TypeScript 6 compatibility package (`@typescript/typescript6`, binary `tsc6`), never in the main checks (D114). M0 records both compilers for the editor-facing checks. Linting does not use typescript-eslint until it supports TypeScript 7. See D111.

**Internal goal:** Keep the data model understandable as the system grows, while safety, capabilities and correctness scale with it.

## 1. Decisions log

Moved to `okmodel-decisions.md` (D1–D132). This file is the normative spec; every section states a rule, an example and the guard that enforces it.

## 2. Design rules and the internal goal

1. Every feature is weighed against the internal goal: the model must stay understandable as it grows.
2. A table is a self-contained module.
3. No imports between table files.
4. Cross-cutting behavior is a trait.
5. One error type, grouped into categories.
6. Explicit over implicit: unbounded reads, unfiltered writes, bypassing tenancy or presets, need a reason.
7. Safe defaults flow down; exceptions are declared where they happen.
8. Input from outside is data, never query structure (D14, D15).
9. Types are keyed by table name, shallow and flat.
10. Capabilities are known before running.
11. Every rule is enforced by types, runtime, `okm check` or CI.
12. Logical intent is the public contract; physical execution may change without API changes.
13. Every implicit behavior is traceable to where it came from.
14. Same semantics, not same features: semantics are identical on every driver; features differ and are declared. What a driver or dialect lacks is refused clearly, never imitated silently, and the API is never reduced to the least capable driver.
15. Escape ladder: typed builder, then composed `sql` fragments, then typed raw SQL, then `sql.raw` with a reason, then a raw migration. Every step keeps the maximum safety it can (tenancy, parameterisation, dependency tracking) and never silently drops one.
16. The core is runtime-agnostic: no `node:*` imports (enforced in CI), context is passed explicitly (`db.for(...)`), and the package's own API is usable under `erasableSyntaxOnly`. An `AsyncLocalStorage` helper is optional (`okmodel/als`).
17. Target, connection and routing are separate concerns. An operation resolves to one endpoint; the endpoint owns a pool; the pool owns connections. Nothing above the pool sees a URL, a pool or a connection, and the primary is never treated as one more replica (section 3.6, invariants A–K).

### Measuring the internal goal

Understandability — type measurement in CI (D114) on 10-, 50- and 200-table fixtures:

| Measure | Pass condition |
|---|---|
| Instantiations per benchmark query | below a fixed ceiling set from the M0 run |
| Growth with schema size | linear across the three fixtures |
| Check time | below a fixed ceiling set from the M0 run |
| Hover output | flat objects, no internal helper types (snapshot tests) |
| Type errors | every detectable misuse shows an `OKM` code and a plain sentence |

Safety and correctness — also in CI:

| Measure | Pass condition |
|---|---|
| Tenant isolation | the built-in cross-tenant check passes for every table in the test fixtures | `isolation.property` |
| Migration safety | every generated migration in the fixture history passes the linter with zero unreasoned overrides |
| Injection | fuzz tests feeding JSON request bodies into `where`, `select`, `orderBy` and `filters()` never change query structure |

## 3. Config, schema, connect

| File | Responsibility | Placement question |
|---|---|---|
| `okm.config.ts` | tooling: CLI, build, migrations | used only by the CLI? |
| `db/schema.ts` | the model | changes a type, a field or data behavior? |
| `db/client.ts` | runtime | varies by environment or at runtime? |

### 3.1 `okm.config.ts`

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./db/schema.ts",
  migrations: "./migrations",
  queries: "./db/queries",
  database: process.env.DATABASE_URL,   // one target named "default"; direct connection, not a pooler
  roles: { migration: "app_owner", app: "app_runtime" },   // migrations run as `migration`; the runtime connects as `app`
  lint: { migrations: "strict" },
});
```

**Targets and protection.** `database` is the shorthand for one migration Target named `default`: a string or `{ url, protected: true }`. Several environments use `targets` instead, a map of names to the same shapes (section 19.8):

```ts
export default defineConfig({
  schema: "./db/schema.ts",
  targets: {
    production: { url: process.env.PROD_DATABASE_URL, protected: true },
    staging: process.env.STAGING_DATABASE_URL,
    preview: process.env.PREVIEW_DATABASE_URL,
  },
});
```

With more than one target every command that touches a database needs `--target <name>`; without it the command fails (OKM1853) rather than guessing. A target is always a primary, reached with the migration role. A `protected` target allows read-only commands and `expand` migrations and refuses everything else unless `--allow-protected` is passed (policy table in section 19.7); every command prints the target it acts on. Protection belongs to the target, not to `NODE_ENV` (OKM1850), and never affects the application's runtime connection.

### 3.2 `db/schema.ts`

```ts
import { schema } from "okmodel/pg";
import { timestamps } from "okmodel/traits";
import { citext } from "okmodel/pg/citext";
import { pgTrgm } from "okmodel/pg/pg_trgm";
import { vector } from "okmodel/pg/vector";
import { users } from "./tables/users";
import { lists } from "./tables/lists";
import { tasks } from "./tables/tasks";
import { countries } from "./tables/countries";

export const appSchema = schema({
  requires: { postgres: ">=17" },   // minimum database engine
  casing: "snake",
  codecs: { bigint: "string", numeric: "string", timestamps: "temporal" },
  traits: [timestamps()],
  tenancy: { key: "tenantId", type: "uuid", strategy: "column" },
  validation: false,
  extensions: [citext(), pgTrgm(), vector({ version: ">=0.7" })],
  functions: [touchUpdatedAt],
  triggers: [tasksTouch],
  views: [activeTasks],
  tables: [users, lists, tasks, countries],
});

declare module "okmodel" {
  interface Register { schema: typeof appSchema }
}
```

### 3.3 `db/client.ts`

```ts
import { connect } from "okmodel/pg/postgresjs";
import { appSchema } from "./schema";

export const db = connect(process.env.DATABASE_URL!, {
  schema: appSchema,                 // required: the runtime needs the catalog
  hookm: [tracing()],
  logger: console,
  errors: { http: { conflict: 409 } },
  max: 10, ssl: "require",           // driver-specific, typed
});

connect(existingClient, { schema: appSchema });   // wrap an existing client

connect({ primary: url, replicas: [r1, r2] }, { schema: appSchema });        // topology, section 15.1
connect(url, { schema: appSchema, tenancy: { registry } });                  // tenant registry, section 9.1 (M5)
```

- On connect: the server is PostgreSQL 15 or newer (OKM1803). `schema({ requires })` can name an older major on purpose, and the server must satisfy that range (OKM1802). Dialect match is OKM1801.
- There is no user-facing schema or edition version. The package version is the contract: features exist or not by release, and default changes ship with `okm upgrade` codemods. The catalog format version is internal and lives in `okm.lock.json`.
- Each `connect()` returns a client typed by its own schema, independent of `Register`.

### 3.4 Multiple schemas

- `connect({ schema })` is the authoritative runtime configuration. `Register` is a TypeScript convenience for inference and defaults only; nothing at runtime reads it.
- Module augmentation applies to the TypeScript program (project) that includes the declaration, not automatically to a whole monorepo.
- Every public type also accepts an explicit schema: `Row<"events", typeof reportsSchema>`, `Client<typeof reportsSchema>`, `TableName<typeof reportsSchema>`. `okm check` warns on more than one `Register` augmentation in one project (OKM1025).

Monorepo pattern — a shared package owns the schema and its registration; apps consume it:

```text
packages/db/
  src/tables/*.ts
  src/schema.ts        export const appSchema = schema({...}); declare module "okmodel" { interface Register {...} }
  src/index.ts         export * from "./schema"   (the augmentation ships in the emitted .d.ts)
apps/api/              import { appSchema } from "@app/db"; connect(url, { schema: appSchema })
apps/worker/           same import → same types
apps/reports/          uses reportsSchema with explicit types: Client<typeof reportsSchema>
```

Any project that imports `@app/db` includes the augmentation and gets inference; a project with a different schema uses explicit types.

### 3.5 Defaults: what happens if you write nothing

| Topic | Default | Override |
|---|---|---|
| Validation | off (`validation: false`) | schema, table, or call |
| Tenancy | inherited from the schema strategy | `via`, `global("reason")` |
| Traits | schema default traits apply to every table | `omitDefaults` with a reason |
| Archived rows | hidden from reads | `withArchived()`, `onlyArchived()` |
| `archivable` strategy | `column` | none in M1 |
| `delete` | permanent | never changed by traits |
| Unbounded reads, unfiltered writes | rejected | `.all("reason")` |
| Unknown input keys | dropped | none |
| Hidden fields | excluded from reads | named in `select` |
| Extensions | none installed; each is declared in `extensions` | add to `extensions` |
| Cancellation | none unless `signal` or `timeout` is given; `connect({ timeouts })` sets ceilings | per call |
| Read routing | automatic across configured replicas; the primary when there are none | `.primary()`, `.replica()`, `routing` |
| Read consistency | session read-your-writes (`routing.consistency: "session"`) | `"eventual"`, `.replica({ consistency: "eventual" })` |
| Protected target | read-only commands and `expand` allowed | `--allow-protected` |
| Application role privileges | `roles.app` receives default privileges on every managed object | `grants` (M2) |
| Raw SQL | rejected | `sql.raw` with a reason |
| Migration apply | pipeline only | none in production |

### 3.6 Catalog, target, connection, routing

Five different questions, five different places:

| Question | Concept | Lives in |
|---|---|---|
| What exists and how is it defined? | Catalog | `schema()` (namespace, tenancy strategy, namespace template) |
| Which deployment destination? | Target | `defineConfig()` (`database` or named `targets`) for tooling; the tenant registry for tenants |
| How do I reach it? | Connection (topology, endpoints, pools) | `connect()` |
| Where does this operation go? | Routing | `connect()` policy (`routing`) plus per-call constraints (`.primary()`, `.replica()`) |
| Where may schema changes be applied? | Migration authority | `defineConfig()` with the migration role; primaries only |

`Catalog ≠ Target ≠ Connection`, `Tenant registry ≠ Connection`, `Routing ≠ Migration authority`. Connection URLs never appear in `schema()`.

**Vocabulary (normative).** One word means one thing throughout this document:

| Term | Meaning |
|---|---|
| **Target** | A logical deployment destination: a name, a class (`shared` or `tenant`), a protection flag and a catalog namespace binding. Migrations, backfills and the tenant registry work on Targets. A Target is not a connection |
| **Topology** | The endpoints of one Target: exactly one primary and zero or more replicas |
| **Endpoint** | One physical database address with a role (`primary` or `replica`). Owns exactly one pool. Internal; never public API |
| **Pool** | The connections of one endpoint, opened through the adapter |
| **Connection** | One connection in a pool; a transaction reserves one for its whole life |
| **Tenant registry** | Resolves a tenant id to a Target and a Target to its connection configuration (a URL or a topology); it is not a connection |
| **Session** | A context client (`db.for(...)`) or the root client, with the write position used for read-your-writes |

```text
Tenant ─ registry ─► Target ─ resolver ─► Topology ─► Endpoint ─► Pool ─► Connection
Operation ─► Router (role, consistency) ─► Endpoint selection ─► Pool ─► Connection
```

**`connect()` takes one of two shapes for its first argument:** a string (the common case, unchanged) or a topology `{ primary, replicas }`. It is the default Target: the shared or control database. The tenant registry is not a connection and is passed as `tenancy: { registry }` (section 9.1). Each shape adds; none changes the meaning of the others.

```ts
export const db = connect(url, { schema: appSchema });
export const db = connect({ primary: url, replicas: [r1, r2] }, { schema: appSchema, routing: { fallback: "primary" } });
export const db = connect(url, { schema: appSchema, tenancy: { registry } });   // M5
```

**Invariants.** Each has a named CI test; a rule without one is design intent.

| | Invariant | CI test |
|---|---|---|
| A | Configured replicas automatically participate in eligible read routing | `routing.auto` |
| B | The primary is authoritative and is never merely treated as a replica | `routing.classes` |
| C | Endpoint selection and connection selection are separate concerns | `pool.separation` |
| D | A transaction is bound to one target and one transaction connection | `tx.affinity` |
| E | Read-your-writes is based on the committed WAL position | `consistency.position` |
| F | An explicit replica requirement never silently falls back to the primary | `routing.strict` |
| G | The tenant registry resolves Targets; it is not itself a connection | `target.resolution` |
| H | A Target is a logical destination, not a physical connection: plans and run state hold no connection details | `plan.no-connection` |
| I | `batch()` has the same documented atomicity contract on every driver | `batch.atomic` |
| J | A new Target is provisioned from the current snapshot without replaying history, and equals a fully migrated one | `provision.equivalence` |
| K | One operation is routed once: all its statements run on one endpoint | `routing.once` |

**Namespaces.** Every catalog object carries an explicit namespace, and emitted SQL is always schema-qualified; nothing depends on `search_path`. The default namespace is a setting (`schema({ namespace })`, default `public`) that is written into the catalog and the snapshots, never assumed. A PostgreSQL schema is a namespace, not automatically a tenant or a service. OKModel has no `microservice` concept: service boundaries are deployment and ownership boundaries above the catalog.

**Several catalogs on one database.** Each `schema()` has its own namespace, ownership and migration history. A catalog may reference objects another catalog owns: they are declared `external`, schema-qualified, and verified but never altered. `external(identityUsers)` turns a table exported by another catalog into an external definition that keeps its identity. `okm catalog export` writes a catalog snapshot that a dependent verifies in CI, like the previous-release check. Foreign keys across catalogs are allowed only within one database (OKM1842 otherwise) and `okm check` lists them as coupling.

## 4. Dialects and capabilities

```ts
import { table, t } from "okmodel/pg";
import { table, t } from "okmodel/sqlite";
import { table, t } from "okmodel/mysql";
import { table, t } from "okmodel/sql";   // common subset
```

| Layer | Declared by | Checked by |
|---|---|---|
| Dialect | import path | types |
| Engine version | `schema({ requires: { postgres: ">=17" } })` — the minimum gates features in types | types (OKM1110) + connect (OKM1802) |
| Driver | execution capabilities only: `transactions: "interactive" \| "batch"`, `stream`, `listen`, `cancel`, `prepared: "named" \| "unnamed" \| "none"`, `describe`. Atomic `batch` is not a flag: every driver provides it (section 15) | types (every flag gates the API: `.stream()`, `tx()`, cancellation and `listen` are absent from the client type when the driver lacks them; a dynamic call fails with an OKM error at runtime) |

Dialect and driver are different axes: SQL capabilities (`lateral`, `returning`, `SKIP LOCKED`, generated columns) belong to the dialect and engine version; every driver on one dialect sends the same SQL. Neon over HTTP is `transactions: "batch"` on the same Postgres dialect. Reading WAL positions (`pg_current_wal_insert_lsn()`, `pg_last_wal_replay_lsn()`) is plain SQL, so it is a dialect and engine capability (`replication.position`), not a driver flag.

The capability registry is data: a serialisable manifest per dialect and version, not code. One capability registry drives types, `okm check` and the docs' compatibility table. Every feature is classified `native`, `portable`, `emulated` (works through another mechanism, e.g. partial uniques via generated columns on MySQL) or `unsupported`; `inspect()` shows when emulation is used.

Prepared statements: fingerprints name prepared statements only where the driver declares `prepared: "named"`; behind poolers in transaction mode (older pgbouncer) use `"unnamed"` or `"none"`; conformance covers each.

Adapters by milestone: M1 `okmodel/pg/postgresjs`, `okmodel/pg/pglite` · M2 `okmodel/pg/pg`, `okmodel/pg/bun`, `okmodel/pg/neon` · M3 SQLite adapters · M4 `okmodel/mysql/mysql2`.

### 4.1 Extensions (Postgres)

**One contract, three sources.** An extension is an `extension()` definition listed in `schema({ extensions })`. Where the definition comes from is the only difference:

| Source | Who writes the definition | Use |
|---|---|---|
| Built-in, by Postgres version (contrib) | okmodel | `import { pgTrgm } from "okmodel/pg/pg_trgm"` |
| Built-in, outside Postgres (pgvector, PostGIS) | okmodel | `import { vector } from "okmodel/pg/vector"` |
| Developer-provided | the developer, or the author of an npm package (`okmodel-ext-*`) | a project file, or `bun add` and `import` |

**TS is immediate.** Adding a definition to `extensions` makes its types, operators, functions and index methods available as ordinary typed TypeScript, inferred from the definition. There is no code generation for use. The extension's functions return typed SQL fragments, so they compose inside raw `sql` and the other way around.

```ts
extensions: [pgTrgm(), vector({ version: ">=0.7" })],
find({ where: { name: pgTrgm.similar(q) }, orderBy: pgTrgm.similarity("name", q) })
```

**Flow.** Declare in `schema()`; TS works at once; `okm generate` (`okm migrate plan`) produces the SQL; `okm push` (development only) or `okm migrate` applies it. `generate` produces SQL only.

**Built-in support.** Built-in definitions are produced by our own CI by introspecting real Postgres containers for each major version (and images with pgvector and PostGIS), plus a small hand-written naming overlay, and ship as package source. The version registry therefore comes from data, not memory. Users never run this generator.

| Extension | Provides | Milestone |
|---|---|---|
| `citext` | case-insensitive text type | M1 |
| `pg_trgm` | similarity operators, GIN/GiST indexes, `ILIKE` acceleration | M1 |
| `unaccent`, `hstore`, `ltree`, `btree_gist`, `btree_gin`, `fuzzystrmatch`, `pgcrypto` | types, operators, functions; `btree_gist` enables `exclude` constraints; `ltree` backs `descendants` / `ancestors` | M2 |
| `uuid-ossp` | compatibility only (core provides uuid functions) | declare-only |
| `vector` (pgvector) | `vector`, `halfvec`, `sparsevec`, distance operators, `hnsw` / `ivfflat` indexes, per-query `efSearch` / `probes` | M2 |
| PostGIS | `geometry`, `geography`, GiST indexes, basic spatial operators; separate `okmodel/pg/postgis` | M3 |
| Any other server extension | `extension("name")` without a definition: full lifecycle, no typed API; use `sql` | M1 |

TimescaleDB, ParadeDB and pg_partman add catalog objects rather than types and are evaluated after 1.0.

**Version awareness.** Definitions read `requires.postgres` and the declared extension version. A feature the declared versions lack (`halfvec` below pgvector 0.7, `uuidv7()` below Postgres 18) fails at schema build (OKM1812). Core features are never gated behind an extension.

**Lifecycle through migrations.**

| Change | SQL | Class |
|---|---|---|
| add | `CREATE EXTENSION ... VERSION ... SCHEMA ...` | expand |
| raise `version` | `ALTER EXTENSION ... UPDATE TO ...`; the path is checked in `pg_extension_update_paths` at planning time when a server is attached; an offline plan marks the step `path-unverified` and apply preflight checks it before any step | expand |
| move schema | `ALTER EXTENSION ... SET SCHEMA` (relocatable only; a non-relocatable extension is refused at planning, OKM1814) | contract |
| remove | `DROP EXTENSION`, never `CASCADE`; refused by the linter while a column or index depends on it | contract |
| lower `version` | not supported by Postgres | refused (OKM1814) |

Objects that belong to an extension (found through `pg_depend` deptype `e`) are excluded from introspection: never loaded, never diffed. Objects declared in `provides` stay `external`. The extension version is unpinned by default: the installed version is recorded for information and drift ignores it unless the declaration pins one (D118). `CREATE EXTENSION` runs from the migration role only; the application never installs anything. `okm migrate plan` and `okm doctor` compare the declaration with `pg_available_extensions` on the connected server, so an unavailable extension fails at planning, not at deploy. Object names are schema-qualified; nothing depends on `search_path`.

**Runtime settings** (`hnsw.ef_search`, `pg_trgm.similarity_threshold`) are per operation, not per connection: `vector.cosine(col, q, { efSearch: 100 })` wraps the statement in a short transaction with `SET LOCAL`, which stays correct behind poolers in transaction mode.

**Safety.** An extension adds types, operators, functions and index methods only. It cannot alter queries or read data; its SQL is tagged, so injection rules apply; final safety verification runs after every contribution. A definition used twice fails at build (OKM1813). `okm ext test` runs a reduced conformance suite; npm and project definitions must pass it to be called compatible.

**Own definitions.** A developer writes `extension("acme_geo", { requires, provides: { types, operators, indexMethods, functions, triggers, views } })`. Functions, triggers and views are first-class catalog objects (section 5.7), owned by the extension as `external`. Forward-only SQL bundles do not exist; `okm migrate new --sql` is the explicit escape hatch.

**Extension without a definition.** `okm ext scaffold <name>` reads the connected server's catalog (`pg_depend`, `pg_type`, `pg_proc`, `pg_operator`, `pg_settings`) and prints a starting definition that the developer owns and edits. It is an authoring aid, not part of the normal flow (M2).

### 4.2 Layers and the driver contract

Dependencies point downward only:

```text
L4 tooling    CLI, migration engine, testing, conformance
L3 runtime    connect(), target resolution, topology, router, pools, sessions, transactions, hookm
L2 adapters   okmodel/pg/postgresjs, okmodel/pg/pglite, ... (implement the Driver contract)
L1 dialects   okmodel/pg, ... (column types, codecs, capability data, compiler, DDL,
              introspection and normalisation, SQLSTATE mapping)
L0 contracts  catalog, identity, hashing, logical query types, Driver and Dialect
              interfaces, error types, capability types
```

- L0 imports nothing above it. An adapter imports only L0 contract types. Dialects never import adapters. Nothing imports L4.
- The catalog compatibility check lives in L0/L1, so the runtime and the migration engine share it without depending on each other.
- Traits and extensions: the mechanism is L0; dialect-specific realisation (`enforce: "trigger"`, pgvector definitions) is L1.
- The import graph is checked in CI (`layers-check`); a violation fails the build.

**Driver contract** (public types in L0; adapters and community drivers implement them, `okm driver test` verifies them):

- `open(config)` returns a `DriverPool` for one endpoint; the runtime opens one per endpoint and never shares a pool between endpoints. Adapters wrap their driver's native pool (postgres.js instance, `pg.Pool`); an embedded driver such as PGlite is a pool of one.
- `DriverPool.execute(text, params, { signal, timeout })` returns `{ rows, count, notices }`; `count` is the affected-row count, `notices` are server-generated messages.
- `DriverPool.batch(statements, { signal, timeout })` is **required** and atomic: all statements commit or none, results in order (section 15, batch contract). It is part of the contract, not a capability.
- `DriverPool.reserve()` returns a dedicated `DriverConnection` (`execute`, `release`); it exists when `transactions: "interactive"` and carries every transaction (connection affinity, section 15.2).
- `DriverPool.stats()` returns `{ size, idle, inflight, waiting }`, a signal for selection strategies. `close()` releases resources.
- Other optional members follow the capability flags of section 4: streaming, `describe`, `cancel`.
- `DriverError`: `{ sqlstate?, constraint?, table?, column?, detail?, cause }`. Each adapter normalises its driver's error into it, because drivers expose these fields differently; the dialect maps `DriverError` to `OkmError` kinds. Drivers never construct `OkmError`.
- Values cross the boundary in the wire representation the dialect declares; codecs live in the dialect. Conformance checks null semantics, timestamps, numeric, bigint, JSON and arrays on every adapter.

## 5. Architecture: catalog and query pipeline

### 5.1 The catalog

- `schema()` produces one deterministic catalog. It is the single source for types, runtime metadata, query compilation, migrations, capability checks, error mapping, diagnostics and tooling.
- The catalog models every database object with one contract (kind, identity, owner, canonical definition, dependencies, provenance; section 5.7). The object family is tables, columns, indexes, constraints, sequences, extensions, views, materialized views, functions, triggers, policies and grants; partitioned tables (range, list, hash), roles and default privileges are part of the family. M0 confirmed the contract for table, column, index, constraint, sequence, extension, view, materialized view, function, trigger, policy, domain, partitioned table, role, grant and default privilege; procedures, aggregates, operators, casts, event triggers and foreign tables fit the same contract but are not yet checked. Copied partition primary keys and inherited indexes are not catalog objects. The contract is frozen (D116).
- Every object has a stable identity. Constraint and index names are generated deterministically (dialect identifier limits handled with a hash suffix) and stored in the catalog; renaming a field does not silently rename its constraints. Error mapping, migration diffs and introspection rely on these names.
- Ownership is part of the catalog contract from M1, for every object kind (tables, views, materialized views, functions, triggers, grants, extension-owned objects). M1 implements `managed` and `external`; M2 adds `ignored` and the explicit `owner:` declaration on tables. `managed` (OKModel owns the DDL), `external` (known and queryable, never altered: PostGIS tables, DBA-created indexes, views owned by another team), `ignored` (invisible to diffs). `table(name, fields, { owner: "external" })`.

### 5.2 Query pipeline

```
API call
  → logical query (tables, fields, relations, filters, ordering, bounds)
  → presets, traits, tenancy, archive visibility, hidden fields (each tagged with its source)
  → final safety verification
  → physical plan (strategy per relation, statement count)
  → dialect SQL + parameters
  → driver
  → decode, projection, hookm
```

- **Final safety verification** runs after every contribution and before planning. It re-checks: tenant predicate on every tenant table touched, guarded fields absent from writes, hidden fields absent from default projections, bounds on reads and to-many includes, filters on writes, archive rules (active set by default, cascade contract), every value parameterised, capability requirements. A violation throws OKM1190 with `violations`: every violated rule in a stable sorted order, each naming the rule and the contribution that caused it (`rule` and `contribution` repeat the first). Caller filters are recorded with provenance `caller` before presets run, so contributions can add predicates but never remove one (D125, D126). Only the explicit escape hatches (`unscoped(reason)`, `.all(reason)`, `.trusted(reason)`, `allow`) pass, and they are recorded in the plan.
- Hookm are read-only in 0.x; nothing outside the pipeline can rewrite a query.

### 5.3 API taxonomy and guarantees

A logical operation is what the caller means; a method is how it is spelled. One method can carry several modes and still be one logical operation.

**Rule for the surface:** a separate method exists only when the **result shape** or the **logical intent** differs. Variants that share both become modes of the same method.

| Layer | Members |
|---|---|
| Core operations | `find`, `insert`, `update`, `delete` |
| Read shapes | `one` (single row or `null`), `page` (items + cursor), `count`, `exists`, `aggregate` |
| Modes | conflict handling and first-or-create on `insert`; cardinality (single target or per-row list) and row locking on `update`; row locking on `find` inside a transaction |
| Lifecycle operations | `delete` (permanent), `archive` and `restore` (only on `archivable` tables) |
| Relationship operations | `sync` |
| Execution primitives | `tx`, `batch` |
| Query modifiers | `.inspect()`, `.sql()`, `.explain()`, `.safe()`, `.stream()`, `.required()` |
| Routing constraints | `.primary()` and `.replica()` on reads; routing is otherwise automatic (section 15.1) |

Guarantees are invariants, not a list of methods. A guarantee without a named CI test is design intent, not a guarantee:

| Guarantee | Contract | CI test |
|---|---|---|
| Tenant isolation | every statement on a tenant table carries the tenant predicate; verified by the final safety pass | `isolation.property` |
| Bounded statements | reads and relation loading: the statement count is determined by query shape, never by result cardinality; no lazy loading. Writes may be split by input size or driver limits (chunked inserts), always inside one transaction | `statements.shape` |
| Snapshot reads | a multi-statement read runs in one snapshot. Outside a transaction: a read-only `REPEATABLE READ` transaction. Inside `REPEATABLE READ` or `SERIALIZABLE`: that transaction. Inside `READ COMMITTED`: the planner falls back to a single statement, or the call fails (OKM1191) if none exists | `snapshot.consistency` |
| Declared atomicity | each operation and mode states its atomicity and race behavior (table below) | `atomicity.table` |
| Deterministic semantics | the small-API semantics table holds on every driver | `semantics.conformance` |
| Final safety verification | no composition can remove a core invariant except through a named escape hatch with a reason | `safety.property` |
| Routing | operations that require the primary never reach a replica; `.replica()` never silently reads the primary; one operation, one endpoint | `routing.property`, `routing.strict`, `routing.once` |
| Session read-your-writes | a read after a committed write in the same session never sees older data, or falls back to the primary | `consistency.position` |
| Batch atomicity | the same all-or-nothing contract on every driver | `batch.atomic` |

M1 ships one physical strategy per dialect (Postgres: single statement with `LATERAL` includes); others can be added without API changes.

| Operation and mode | Atomicity | Statements | Race behavior |
|---|---|---|---|
| `find` with includes | one snapshot | 1 in M1 | — |
| `insert([...])` | all or nothing | 1 per chunk, chunks in one transaction | — |
| `insert` with `onConflict: { update }` | per row | 1 | safe on the named unique |
| `insert` with `onConflict: "return"` | per row | 1–2 | safe on the named unique; returns the existing row |
| `update([...])` per-row list | all or nothing | 1 | — |
| `update` with `lock: "skip"` | per statement | 1 | rows locked by others are skipped (job queues) |
| `archive` / `restore` | all or nothing | 1 per table in the cascade chain | `restore` fails on unique conflicts |
| `sync` | all or nothing | 2–3 in one transaction | — |
| `batch([...])` | all or nothing on every driver (driver contract, section 15) | n | — |

Mode names above are the current proposal; they are fixed once the semantics table is final.

### 5.4 Inspection

```ts
const q = scoped.tasks.pending().find({ include: { list: true }, limit: 50 });

q.inspect()                 // stable, documented structure
q.sql()                     // { text, params }
await q.explain()           // database EXPLAIN (M2)
```

```
tasks.find                   fingerprint Q_4F92A1
applied
  preset   pending           completed_at IS NULL
  tenancy  schema.tenancy    tenant_id = $1
  hidden   users.passwordHash excluded
bounds     limit 50; include list (to-one)
strategy   postgres: single statement, lateral include
routing    auto → replica-b (weighted; session position satisfied)
safety     tenant ✓  bounded ✓  parameterised ✓
```

Every rule's provenance includes its source location (`schema.ts:12`), recorded when the table, trait or preset is defined, so the output above can say where each rule came from. In development, repeating one fingerprint many times inside one request context warns with the calling line (N+1 detection without lazy loading).

`inspect()` answers what was asked, what OKModel added and why, and how it will run. The internal IR is not public in 0.x.

### 5.5 Fingerprints

A deterministic hash of the canonical logical query and chosen strategy, excluding parameter values. Used for prepared-statement names, low-cardinality telemetry attributes, slow-query grouping in the dev inspector, and test snapshots. Future modules (caching, performance analysis) build on it.

### 5.6 Value pipeline

- Write: input → transforms → validation → codec encode → database.
- Read: database → codec decode → projection (hidden fields removed) → result.
- Transforms and validation run only when validation is enabled for the write; codecs always run.
- Reusable value types are ordinary constants, no new concept:

```ts
export const email = () => t.citext().validate([v.trim(), v.lowercase(), v.email("email_invalid")]);
export const money = () => t.numeric(12, 2);
```

### 5.7 Database objects

Raw SQL is not a database object. A declared view, function, trigger or grant is represented semantically in the catalog and takes part in identity, ownership, dependency tracking, diffing, planning, introspection, diagnostics and lifecycle like any table. Raw SQL stays an explicit escape hatch (`okm migrate new --sql`, `sql.raw`).

| Kind | Identity |
|---|---|
| table, view, materialized view, sequence, type | `(namespace, name)`; the namespace is static or a template (`tenant_{id}`) |
| column, index, constraint | `(parent, name)`, deterministic names |
| function | `(schema, name, argTypes[])`, so overloads are distinct |
| trigger, policy | `(table, name)` |
| grant | `(role, object, privilege)`, a structured key exempt from the 63-byte rule |
| default privilege | `(forRole, namespace, objectKind, grantee, privilege)` |
| role | `name` (cluster object) |
| extension | `name` |

**Templates in identity.** Snapshots and diffs store the logical identity, including the namespace template, never the concrete tenant names. A migration is therefore written once and resolved to concrete namespaces at execution time (section 19.5).

Every node carries: owner (`managed` / `external` / `ignored`), a canonical definition: the normalised structure, never authoring text (view, materialized view and function bodies are judged by a scratch reprint); its hash drives diff and drift (D117), dependency edges at object or **column** granularity, and provenance (which trait, extension or file contributed it). Each kind declares its operations: create, replace (when compatible), alter, drop, and recreate-with-dependents.

**Views.** Defined with the OKModel query builder, so column types and dependencies are inferred like `find`; alternatively SQL with declared columns, verified against a scratch database where dependencies are read from `pg_depend`. Views are read-only in the client: `db.views.activeTasks.find(...)`.

**Materialized views.** `materializedView()` is a separate kind: no `CREATE OR REPLACE`, so a change is drop, create and populate. They own indexes and a `refresh` declaration; `REFRESH ... CONCURRENTLY` needs a unique index (OKM1822). `WITH NO DATA` avoids a long lock at creation; populate is a planned data step shown in the plan. Scheduling refreshes is left to `pg_cron` or the application.

**Functions.** `fn()` declares arguments, return type, language, `volatility` and `dependsOn`. Calls are typed SQL fragments (`fn.slugify(col)`) usable in predicates, projections, ordering and computed fields; extension functions use the same kind. Postgres does not track dependencies inside plpgsql bodies, so plpgsql functions require `dependsOn` (OKM1824); `LANGUAGE sql` with `BEGIN ATOMIC` is inferred. `SECURITY DEFINER` requires an explicit `search_path` (OKM1823).

**Triggers.** `trigger(name, { on, timing, events, level, when, calls })` in the schema's `triggers` list. Dependencies: the table (and `UPDATE OF` columns) and the function. Traits contribute triggers and functions with provenance (`timestamps({ enforce: "trigger" })`, `auditable()`), and `inspect()` and `okm doctor` list the triggers that affect a table.

**Grants.** With `roles: { migration, app }` the catalog emits `GRANT` and `ALTER DEFAULT PRIVILEGES FOR ROLE <migration role>` for the application role on every managed object, so a new table is reachable without manual steps; fine-grained grants come in M2. Migrations run as the migration role: a login role, or the runner issues `SET ROLE` once at session start, recorded in the run report and never inside a plan. Roles are cluster objects: a role named in `roles` must exist and is `external` by default (checked by `okm doctor`); a declared managed role is created if missing (existence read from `pg_roles`, no `IF NOT EXISTS`), altered in place and never dropped by a plan. `CREATEROLE` is checked in doctor and apply preflight (D119).

**Planning rules.**

| Change | Behavior | Class |
|---|---|---|
| create | dependency order: types and tables, then functions, triggers, views | expand |
| replace, compatible (function with the same signature; view appending columns) | `CREATE OR REPLACE`, flagged "behavior change" in the plan | expand |
| replace, incompatible; change to a column a view depends on | drop dependents in reverse order, alter, recreate (planned by OKModel, never `CASCADE`) | contract |
| drop | reverse dependency order; refused while a dependent remains | contract |

**Tenancy.** A view over tenant tables inherits the classification. If it exposes the tenant key, the tenant predicate is applied to it; otherwise `okm check` fails (OKM1820) unless declared `global("reason")`. Views default to `security_invoker` under the `rls` strategy (Postgres 15 and later).

```ts
export const touchUpdatedAt = fn("touch_updated_at", {
  returns: "trigger", language: "plpgsql", volatility: "volatile",
  body: sql`begin new."updatedAt" = now(); return new; end`, dependsOn: [tasks],
});
export const tasksTouch = trigger("tasks_touch", { on: tasks, timing: "before", events: ["update"], level: "row", calls: touchUpdatedAt });
export const activeTasks = view("active_tasks", (q) => q.from(tasks).where({ archivedAt: null }));
```
(The exact builder shape is finalized in M0.)

## 6. Tables

### 6.1 Shape

```ts
// db/tables/tasks.ts
import { table, t, one, many, index, sql } from "okmodel/pg";
import { v } from "okmodel/validate";
import { archivable } from "okmodel/traits";

export const tasks = table("tasks", {
  id: t.id(),
  ownerId: t.uuid().references("users"),
  listId: t.uuid().references("lists", { onDelete: "cascade" }),
  title: t.varchar(200).validate([v.trim(), v.min(1, "title_required")]),
  status: t.varchar(20).picklist(["draft", "active", "done", "cancelled"]).default("draft"),
  notes: t.text().nullable(),
  dueAt: t.timestamptz().nullable(),
  position: t.integer().default(0),
  completedAt: t.timestamptz().nullable(),
}, {
  validate: {
    $row: [v.rule((r) => !r.completedAt || r.completedAt >= r.createdAt, "completedAt", "completed_before_created")],
  },
  traits: [archivable({ cascade: ["reminders"] })],
  relations: {
    owner: one("users", "ownerId"),
    list: one("lists", "listId"),
    reminders: many("reminders"),
  },
  computed: {
    isOverdue: (c) => sql`${c.dueAt} < now() and ${c.completedAt} is null`,
  },
  indexes: (c) => [index(c.tenantId, c.ownerId, c.dueAt)],
  checks: { positionPositive: (c) => sql`${c.position} >= 0` },
  presets: {
    pending: (q) => q.where({ completedAt: null }),
    ownedBy: (q, userId: string) => q.where({ ownerId: userId }),
    dueWithin: (q, hours: number) => q.where({ dueAt: lte(t.now().plus({ hours })) }),
  },
});
// tenantId (tenancy) and createdAt/updatedAt (schema traits) are added by inheritance
```

### 6.2 Options

| Option | Contains |
|---|---|
| `validate` | per-field rule arrays or Standard Schemas; `$row` cross-field rules |
| `validation` | table override of the schema default |
| `traits`, `omitDefaults` | behavior bundles; opting out of schema traits with a reason |
| `tenancy` | `{ via: "relation.path" }` or `global("reason")` |
| `relations` | `one`, `many`, `manyThrough`, `morph`, by table name. `morph("commentable", ["tasks", "lists"])` declares a closed list of targets and returns a flat discriminated union (M2) |
| `computed` | SQL expressions usable like fields |
| `indexes`, `checks` | database indexes, unique constraints, check constraints |
| `primaryKey` | column names of one primary key, including a composite key |
| `presets` | named, typed query refinements; called as `tasks.pending()`. Names may not collide with client methods or the reserved list (`lock`, `watch`, `subscribe`, `stream`, `inspect`, `explain`, `with`, `for`, `as`); collisions fail with OKM1040 and `okm upgrade` renames a preset when a later release claims its name |
| `policies` | row policies |
| `reference` | `{ key, rows }`: rows the application requires to exist (roles, statuses). Declarative and idempotent: applied by `migrate apply` and by provisioning as insert-if-missing by key; never updates or deletes; classified `expand` (section 19.6) |
| `renamedFrom`, `sqlName`, `comment` | table rename declaration, naming, docs |

### 6.3 References by name

References are plain table-name strings (a generic table-name argument cycles through `Register` and blew up type counts in P12, D132). Table names autocomplete in `Row<"…">`, `Insert<"…">` and `Update<"…">`; with emitted types the emitted file also offers the table-name union to `references` (wired with `okm build`). Validated by the schema at construction and startup: unknown table OKM1020, missing/ambiguous FK OKM1021, FK type mismatch OKM1022, duplicate names OKM1023, unlisted table file OKM1024.

### 6.4 Column types (Postgres)

| Group | Builders |
|---|---|
| Keys | `t.id()` (uuid; default `uuidv7()`, or `{ default: "uuidv4" }` for `gen_random_uuid()` (D153), or `{ default: "none" }` when the caller supplies the id), `t.identity()`, `t.uuid()`, `.primaryKey()` on a column, `primaryKey` on the table |
| Integers | `t.smallint()`, `t.integer()`, `t.bigint()` |
| Decimals | `t.numeric(p, s)`, `t.real()`, `t.double()` |
| Text | `t.text()`, `t.varchar(n)`, `t.char(n)`, `t.citext()` |
| Boolean / binary | `t.boolean()`, `t.bytea()` |
| JSON | `t.json<T>()`, `t.jsonb<T>()` |
| Date / time | `t.timestamptz(p?)`, `t.timestamp(p?)`, `t.date()`, `t.time(p?)`, `t.timetz(p?)`, `t.interval(fields?)` |
| Ranges | `t.tstzrange()`, `t.daterange()`, `t.int4range()`, `t.int8range()`, `t.numrange()` |
| Network | `t.inet()`, `t.cidr()`, `t.macaddr()`, `t.macaddr8()` |
| Geometry | `t.point()`, `t.line()` (PostGIS via an extension package) |
| Search / trees | `t.tsvector()`, `t.ltree()` |
| Enums / domains | `t.enum("name", [...])`. `t.domain("name", base, check)` throws OKM1061 until 0.3 |
| Arrays | `.array()`, `.array({ dims: 2 })` |
| Custom | `t.custom({ sqlType, encode, decode, tsType })` |

Modifiers: `.nullable()`, `.default(v)`, `.defaultSql(sql)`, `.primaryKey()`, `.unique({ reason, global })`, `.references(table, opts)`, `.picklist([...], { check })`, `.generated(sql, { stored })`, `.guarded()`, `.hidden()`, `.sensitive()`, `.renamedFrom(name)`, `.sqlName()`, `.comment()`. `.validate(rules | schema)` is not in this version.

`t.id()` with `uuidv7()` or `uuidv4`, and `t.identity()`, are omitted from insert and update. `t.id({ default: "none" })`, `.primaryKey()`, and a composite `primaryKey` are required on insert (optional when the column already has a default) and omitted from update. A declared `requires` below Postgres 18 rejects `uuidv7()` at schema build (OKM1812) and the message names `defaults.id`.

**Client defaults and id generators (0.2, D153, D154).** `.default(x)` takes a literal or a client generator (`uuidv4`, `uuidv7`, `okid(...)`, or a function): the client fills the field on insert when it is omitted, nothing enters the database catalog or its hash, and the column has no database default, so a writer that bypasses okmodel must supply the value. `.defaultSql(sql)` is the database default. `schema({ tables, defaults: { id } })` sets what a bare `t.id()` means; a per-column option wins; `connect({ generators })` replaces a built-in generator for tests. OKID columns are `text` with `COLLATE "C"` so sortable ids order as time. Builder shape (shipped in P19): `t.id({ default: uuidv4 | uuidv7 | okid({ prefix, sortable, length }) })` fills the id in the application; the strings `"uuidv4"`, `"uuidv7"` and `"none"` stay database defaults (`"none"` is column-only, so the insert type requires that id); `okid` and the other generators come from `okmodel/ids`. A literal passed to `.default()` is a database default, a function is a client generator.

**Not in this version.** A builder or option in this table throws OKM1061 and names the version that adds it. `later` means no 0.x version is assigned yet.

| Builder or option | Version |
|---|---|
| `t.domain()` | 0.3 |
| `schema({ extensions, functions, triggers, views })` | 0.3 |
| `schema({ tenancy, traits, validation })` and the same options on `table()` | 0.2 |
| `table({ omitDefaults, presets, validate, validation })` | 0.2 |
| `table({ reference })` | 0.4 |
| `manyThrough` | 0.2 |
| `morph`, `table({ computed, policies })` | later |

- Fields are `NOT NULL` unless `.nullable()`.
- Extensions required by a type (`citext`, `ltree`) are added to migrations automatically.
- `serial` types exist only for imports.

### 6.5 Picklists

```ts
status: t.varchar(20).picklist(["draft", "accepted", "sent", "returned", "cancelled", "archived"]).default("draft"),
```

- TypeScript type becomes the literal union.
- Database: `CHECK (status IN (...))`; `{ check: false }` keeps the list in types and validation only.
- Adding a value generates `ADD CONSTRAINT … NOT VALID` + `VALIDATE`. **Removing a value needs a replacement, and the replacement never lives in the schema** (D131): the schema lists the current values only. `okm generate` compares with the last snapshot, and for every removed value it needs `--replace <table>.<column>.<old>=<new>` (or `=null` for a nullable column); without it generation fails with OKM1541 and the error's `fix` shows the exact flag. The replacement must be in the new list (no chains). The mapping is written into the generated migration as a `backfill()` step (batched by primary key, resumable), in two parts: **expand** moves the existing rows and keeps the old value allowed by the old constraint (so a release still running can write it); **contract** runs a final sweep, then swaps the constraint (`NOT VALID` + `VALIDATE`). A removal never touches the schema file again, and once the migration is applied the schema stays clean. `t.enum` follows the same rule; its contract step recreates the type (Postgres cannot drop an enum value). Several removed values may map to the same or different replacements.
- Display labels (Arabic, English) belong to the UI, not the schema. User-editable lists are lookup tables with FKs, not picklists.

### 6.6 Codecs

Set in `schema({ codecs })`, override per field: `t.bigint({ as: "number" })`. Defaults: `bigint: "string"`, `numeric: "string"`, `timestamps: "temporal"`. Projects that choose `bigint: "bigint"` use `okm.jsonReplacer` for responses because `JSON.stringify` throws on BigInt.

### 6.7 Protected fields

| Marker | Effect |
|---|---|
| (default) | unknown keys in input are dropped |
| `.guarded()` | never filled from `insert`/`update` input; set by code with `{ allow: ["field"] }` |
| automatic guards | `t.id()` with a database default and `t.identity()` (omitted from insert and update); a column `.primaryKey()`, a composite `primaryKey`, and `t.id({ default: "none" })` (supplied on insert, omitted from update); tenant key and trait fields (`createdAt`, `updatedAt`, `archivedAt`, `archiveId`, `version`) |
| `.hidden()` | excluded from default selects and includes; returned only when named in `select` |
| `.sensitive()` | values never appear in logs, error messages, `inspect()` output or fixtures; shown as `[redacted]` even in development |

**One concept, four mechanisms: field exposure.** Every field answers four questions:

| Question | Default | Changed by |
|---|---|---|
| Returned by default reads? | yes | `.hidden()` |
| Filled from external input? | yes | `.guarded()`, and a primary key on update. `t.id()` with a default and `t.identity()` are also omitted from insert |
| Filterable from client input? | no | `tasks.filters({ allow })` |
| Writable by code? | yes | guarded fields need `{ allow }` |
| Values shown in logs, errors, inspection? | parameters only in development inspection; never in fingerprints | `.sensitive()`: always redacted |

### 6.8 Types

```ts
import type { Row, Insert, Update, Input } from "okmodel";

type Task = Row<"tasks">;        // excludes hidden fields unless selected
type NewTask = Insert<"tasks">;  // after transforms, guarded fields excluded
type TaskInput = Input<"tasks">; // before transforms
type TaskPatch = Update<"tasks">;
```

Row types are emitted by default into `.okm/types.d.ts` by `okm build` and `okm dev` (config `types: "emitted"` or `"inferred"`, default emitted). Inferred is the zero-build mode; both give the same shapes (a CI test with `expectTypeOf`). Emitted names derive from table names (`Tasks`, `TasksInsert`, `TasksUpdate`); duplicate table names are rejected at `schema()` construction and by `okm check` (OKM1023), and unknown references are reported at build (OKM1020). M0 measured 0 consumer instantiations for emitted against 53,410 inferred at 200 tables (D120); editor hover is unmeasured, so P12 includes a manual hover and autocomplete check.

## 7. Validation

- **Inline:** `.validate([...])` or `.validate(standardSchema)`.
- **Section:** `validate: { field: [...], $row: [...] }`; cross-field rules only here.
- **One place per field** (OKM1030). Style can be enforced with `validation: { style }`.
- **Rules** run in order, transforms included; `v.onInsert()`, `v.onUpdate()`; messages are keys.
- **Derived rules** from the type: length, required, integer range, precision, picklist, uuid format, JSON shape.
- **Standalone:** `tasks.insert.validate(body)`, `tasks.insert.check(body)`, `tasks.update.validate(body)`, `.pick(...)`, `.omit(...)`; `tasks.insert` is a Standard Schema; JSON Schema export.
- **At write time:** `schema({ validation: false })` → table `validation: true` → call `{ validate: false }`. Shorthand boolean; object form `{ enabled, onRead, style }`. The effective setting drives the input type (`Input` when enabled, `Insert` when disabled). Values from `validate()` are branded and frozen and skip re-validation.

## 8. Traits

| Trait | Adds | Behavior |
|---|---|---|
| `timestamps()` | `createdAt`, `updatedAt` | set in all lanes; `{ enforce: "trigger" }` adds a DB trigger |
| `archivable(opts?)` | `archivedAt`, `archiveId` (column strategy) | enables `archive()` and `restore()`; reads target the active set by default, `withArchived()` / `onlyArchived()` widen it; uniques become partial (`WHERE archived_at IS NULL`; generated-column form on MySQL); `cascade: [...]` names the children archived and restored with the row |
| `versioned()` | `version` | optimistic locking; stale write → category `conflict` |
| `sortable(groupBy?)` | `position` | `move(id, { before \| after })` |
| `auditable()` | history table | before/after snapshots |

`delete()` always means permanent deletion. `archivable()` adds a capability; it never changes what `delete()` does.

#### Archive contract

- **Strategies.** `archivable({ strategy: "column" })` (default, M1) keeps archived rows in the same table with `archivedAt` and `archiveId`, so migrations apply to them automatically. `strategy: "table"` (moving rows to a shared archive table) is deferred: archived snapshots would keep the table's old shape and break restore after migrations; it ships only once snapshots can follow migrations, with the same public contract.
- **`archiveId` is provenance.** Every `archive()` call creates a new `archiveId` shared by every row it archives, including cascaded children. `archive()` returns `{ count, archiveId }`. `restore()` clears `archivedAt` and `archiveId`. Archive → restore → archive produces two different ids; `archiveId` never identifies a record.
- **Cascade.** Children listed in `cascade` are archived in the same operation with the same `archiveId`. `restore` of a row brings back only the rows that carry its `archiveId`; a child archived earlier on its own stays archived. `restore({ archiveId })` restores a whole operation.
- **Unique conflicts.** A restore that would violate a unique now held by an active row fails with the mapped `unique` error naming the key.
- **Parents first.** Restoring a row whose referenced parent is still archived fails (category `input`, naming the parent); restore the parent's operation instead. Same rule for every strategy.
- **Foreign-key contract.** With the column strategy archived rows stay in place, so database FK actions never fire on `archive`. With the table strategy (when it ships), every FK pointing at an archivable table whose delete action is not `RESTRICT`/`NO ACTION` (`CASCADE`, `SET NULL`, `SET DEFAULT`) must be listed in `cascade`, otherwise schema validation fails naming the child table, the FK and its action (OKM1051).
- **Includes.** A to-one include of an archived parent returns `null` unless `withArchived()`; to-many includes exclude archived children.
- **Purge.** `tasks.onlyArchived().delete({ where: { archivedAt: lt(cutoff) } })` permanently deletes archived rows; no separate method.

Project traits: `trait(name, { fields, presets, methods, requires })`, the same API built-ins use.

## 9. Tenancy

### 9.1 Concepts and strategies

Ownership is a field and a preset (`ownedBy`). Tenancy is the isolation boundary, defined once in `schema({ tenancy })`.

| Strategy | Isolation |
|---|---|
| `column` | filter on the key; inserts fill it from context |
| `path` (`tenancy: { via: "project.organization" }`) | `EXISTS` along the path; inserts verify the parent's tenant |
| `composite` (`key: ["organizationId", "workspaceId"]`) | all keys together |
| `rls` (pg) | database-enforced policies (9.4) |
| `schemaPerTenant`, `databasePerTenant` | physical isolation |

**Physical strategies.** In `schemaPerTenant` the tenant tables live in the namespace template (`namespace: "tenant_{id}"`, a deterministic string with no code); in `databasePerTenant` the catalog is instantiated once per tenant database. Neither puts connection details in `schema()`. The registry, which knows which tenants exist and where, is deployment data, defined once in a project module and passed to `connect()` as `tenancy: { registry }` and to `defineConfig()` as `tenants`. It resolves a tenant id to a Target and a Target to its connection configuration; it is not a connection (invariant G). Its shape: `list()` returns the Targets, `resolve(id, { role })` returns a URL, a topology or `{ url, protected }` for the `app` or `migration` role, and an optional `create(id)` creates the empty database for database-per-tenant (infrastructure, outside OKModel). The tenant id passes a sanitizer (uuid hex or `[a-z0-9_]`) before it enters an identifier (a failing id is OKM1122).

### 9.2 Inheritance and integrity

- Every table is isolated by default; exceptions: `tenancy: { via }` or `tenancy: global("reason")`.
- The `column` strategy adds the key to inheriting tables.
- `.unique()` on a tenant table becomes `UNIQUE (tenant_key, …)`; `.unique({ global: "reason" })` opts out.
- Every tenant table has `UNIQUE (id, tenant_key)`; FKs between tenant tables are composite, so no row can reference another tenant's row, even through raw SQL.
- Lint OKM1706: an index on a tenant table that does not lead with the tenant key.
- Changing the tenant key in `update` is refused (OKM1704); a global table referencing a tenant table is flagged (OKM1705).
- Adding tenancy to an existing project requires a backfill migration before the key becomes `NOT NULL`.
- Resolving the tenant from a request is the application's job.

### 9.3 Context client

```ts
const scoped = db.for({ tenantId: session.tenantId });
await scoped.tasks.find({ limit: 20 });
db.tasks;                                           // type error OKM1701
db.unscoped("nightly report across tenants").tasks.count();
db.countries.find({ limit: 300 });                  // global tables on the root client
```

### 9.4 `rls` strategy hardening

- `FORCE ROW LEVEL SECURITY` on tenant tables.
- Tenant set with `set_config('app.tenant', $1, true)` inside the transaction OKModel opens for each scoped call (safe with transaction-mode poolers). For reads that transaction is read-only and part of the operation: it follows the operation's routing (section 15.1) and can run on a replica.
- Policies use the missing-ok form, so an unset tenant returns no rows.
- `connect()` refuses a role that owns the tables or is a superuser (OKM1707).

## 10. Reading

| Method | Returns | Rule |
|---|---|---|
| `find(opts)` | `Row[]` | `limit` or `.all("reason")` (OKM1101) |
| `page(opts)` | `{ items, next }` | keyset; primary key appended to `orderBy` |
| `one(opts)` | `Row \| null` | more than one match → `not_unique`, unless `orderBy` is given (then the first row); `.required()` turns `null` into `not_found` |
| `count(opts)`, `exists(opts)` | `number`, `boolean` | |
| `aggregate(opts)` | grouped rows | |

Query modifiers apply to any read: `.stream()` (async iteration over a server-side cursor, driver capability), `.required()`, `.safe()`, `.inspect()`, `.sql()`, `.explain()`.

```ts
const task = await scoped.tasks.one({ where: { id } }).required();
const next = await scoped.tasks.one({ where: { listId }, orderBy: { position: "asc" } });
for await (const row of scoped.tasks.find({ where: { listId } }).all("export").stream()) { … }
```

### 10.1 Filters with tagged operators

```ts
import { eq, lt, lte, gt, between, startsWith, contains, inList, not, has, none, every, or } from "okmodel/pg";

const today = await scoped.tasks.pending().ownedBy(userId).find({
  where: {
    status: inList(["draft", "active"]),
    dueAt: lt(tomorrow),
    isOverdue: false,
    list: has({ name: startsWith("Work") }),
    reminders: has({ sentAt: null }),
    notes: not(null),
  },
  select: ["id", "title", "dueAt"],
  include: { list: { select: ["name"] } },
  orderBy: { dueAt: "asc" },
  limit: 50,
});
```

- A plain value means equality; `null` means `IS NULL`.
- Operators and relation filters are tagged values created by helpers. JSON cannot create them, so request data can never add an operator or traverse a relation. A plain object where a value is expected is rejected at runtime (OKM1121, its fix names `eq`); `eq(value)` is the equality form for object (json, jsonb) values. An identifier that fails the rules (length, NUL, control characters, unquoted reserved word) is rejected at runtime (OKM1122). Allowlisting a hidden field in a filter or sort allowlist fails at build (OKM1123). A preset's `where` appends (AND) and the preset builder exposes only additive methods, never replacement (D125, D126).
- Field names in `where`, `select`, `orderBy` and `include` are checked against the catalog at runtime (OKM1120).
- `undefined` in `find` filters means "no filter"; in `update`/`delete`, a `where` that becomes empty throws OKM1102.
- One logical operation per call (section 5.3). Reads and relation loading: the statement count depends on query shape, never on result cardinality; no lazy loading. Writes may be split by input size or driver limits, within the operation's declared atomicity.
- To-many `include` requires `limit` or `.all("reason")` (OKM1105); hidden fields and archived rows are excluded from includes.

#### Operators by column type (0.2)

All are tagged helpers from `okmodel/pg`. The planner picks the SQL from the column type, so one name serves several types, and an operator that does not apply to its column is rejected at compile time and at runtime (OKM1124).

| Helper | Column types | SQL |
|---|---|---|
| `contains(x)` | text: substring (as in 0.1); array, jsonb, range: containment | `@>` |
| `containedBy(x)` | array, jsonb, range | `<@` |
| `overlaps(x)` | array, range | `&&` |
| `hasKey(k)`, `hasAnyKey(ks)` | jsonb | `jsonb_exists`, `jsonb_exists_any` (function forms, so a `?` never appears in SQL text) |
| `path(segments, op)` | json, jsonb | `col #>> $1::text[]` compared with `op`; the operand type of `op` picks the cast (number to numeric, boolean to boolean, string to text) |
| `matches(q, { mode?, config? })` | tsvector | `@@` with `websearch_to_tsquery` (default, never throws on user input), `plainto_tsquery` (`"plain"`) or `phraseto_tsquery` (`"phrase"`) |

Atomic write operators (section 11) are `json.set(path, v)`, `arr.append(v)`, `arr.remove(v)`, exported as namespaces (`export * as json`) so each member tree-shakes. Trigram similarity and citext operators arrive with extensions (M2); text search on a plain `text` column is not supported (it needs an expression index) and fails with a clear error.

### 10.2 User-driven filtering

For list endpoints that accept filters from the client:

```ts
const taskFilters = await tasks.filters({
  allow: { status: ["eq", "in"], dueAt: ["lt", "gt"], title: ["startsWith"] },
  sort: ["dueAt", "createdAt"],
  relations: { list: ["name"] },   // explicit: this relation and only these fields
});

const q = taskFilters.parse(request.query);   // only allowlisted fields and operators; OkmError "input" otherwise
await scoped.tasks.find({ ...q, limit: 50 });
```

Relations are filterable only when listed with the exact fields allowed (`relations: { list: ["name"] }`), which serves admin panels without opening arbitrary traversal. Hidden fields can never be allowlisted.

## 11. Writing

| Method | Rule |
|---|---|
| `insert(data \| data[], opts)` | unknown keys dropped; guarded fields refused; auto-chunked. `onConflict`: `"error"` (default), `"ignore"`, `{ on, update }` (upsert), `{ on, return: true }` (first-or-create). `on` must name a unique constraint (OKM1104) |
| `update(target, opts)` | target is `{ where, set }` or a list `[{ id \| where, set }]` (per-row values in one statement). `where` required or `.all("reason")`. `lock: "skip"` with `limit` claims rows (job queues) |
| `delete({ where }, opts)` | permanent deletion of the matched records. On `archivable` tables it targets the active set unless `withArchived()` / `onlyArchived()` is used |
| `archive({ where }, opts)` | `archivable` tables only; returns `{ count, archiveId }` |
| `restore({ where } \| { archiveId }, opts)` | `archivable` tables only; targets the archived set |
| `sync(id, relation, ids)` | relationship operation: set a to-many relation exactly |

```ts
await scoped.tags.insert({ name }, { onConflict: { on: "name", return: true } });          // first-or-create
await scoped.stock.insert(rows, { onConflict: { on: ["sku"], update: ["qty"] } });          // upsert
await scoped.tasks.update(order.map((id, i) => ({ id, set: { position: i } })));           // per-row list
const jobs = await db.jobs.update({ where: { status: "pending" }, set: { status: "running" }, limit: 10, lock: "skip" });
const { archiveId } = await scoped.tasks.archive({ where: { id } });
await scoped.tasks.restore({ archiveId });
await scoped.tasks.onlyArchived().delete({ where: { archivedAt: lt(retentionCutoff) } });   // purge
```

Atomic operators: `inc(n)`, `json.set(path, v)`, `arr.append(v)`, `arr.remove(v)`.

## 12. Semantics of small APIs

Specified before M1 and tested on every driver through the conformance suite:

| API | Behavior |
|---|---|
| `one()` without `orderBy` | fetches at most 2 rows; 0 → `null` (`not_found` with `.required()`), more than 1 → `not_unique` |
| `one()` with `orderBy` | the first row in that order |
| `inList([])` | matches nothing (compiled to `false`), never a SQL error; `notIn([])` matches everything |
| `has()` / `none()` / `every()` | `every()` is true when there are no related rows; `none()` is true when there are none |
| null ordering | `asc` → nulls last, `desc` → nulls first unless `nulls` is set; identical on every dialect (emulated where needed) |
| `startsWith`, `contains`, `endsWith` | literal: `%`, `_` and `\` in the value are escaped; case-sensitive; `iStartsWith` etc. for case-insensitive |
| `like()`, `ilike()` | raw patterns, explicit |
| `null` in `where` | `IS NULL`; `not(null)` → `IS NOT NULL` |
| `update` `set` | `undefined` leaves the field unchanged; `null` sets NULL |
| omitted field on `insert` | the database default applies |
| `returning` | rows as stored, after defaults, generated columns and triggers |
| `update` / `delete` result | `{ count }`; `expect: n` throws `not_found` when the count differs |
| `delete` | permanent; active set by default on `archivable` tables; children follow database FK actions |
| `archive` on an already archived row | not matched (targets the active set): `count: 0`; with `expect` → `not_found` |
| `restore` on an active row | not matched (targets the archived set): `count: 0` |
| `restore` unique conflict | an active row now holds the value → the whole operation fails, category `conflict`, `fields()` set |
| `restore` with an archived parent | fails, category `input`, names the parent |
| `archive` / `restore` scope | tenant context applies; many targets allowed; all or nothing; `expect` as for `update` |
| `archive` / `restore` on a non-archivable table | not present in types; a dynamic call fails with OKM1052 |
| cursors | keyset on `orderBy` plus primary key; stable under concurrent inserts; the cursor encodes its order and is rejected if the order changes (OKM1130) |

## 13. Productivity tools

| # | Tool | pg | sqlite | mysql | Milestone |
|---|---|---|---|---|---|
| 1 | Computed fields | ✓ | ✓ | ✓ | M1 |
| 2 | Top-N per group in `include` | ✓ | ✓ | ✓ | M2 |
| 3 | `has` / `none` / `every` relation filters | ✓ | ✓ | ✓ | M1 |
| 4 | `aggregate` with `bucket(col, unit, { tz })` | ✓ | no tz | ✓ | M2 |
| 5 | Time-zone date helpers | ✓ | partial | ✓ | M2 |
| 6 | Bulk insert with chunking | ✓ | ✓ | ✓ | M1 |
| 7 | First-or-create (`insert` conflict mode) | ✓ | ✓ | ✓ | M2 |
| 8 | Per-row `update` list | ✓ | ✓ (3.33+) | ✓ (8.0.19+) | M2 |
| 9 | Atomic operators | ✓ | no arrays | no arrays | M2 |
| 10 | `sync` | ✓ | ✓ | ✓ | M2 |
| 11 | `descendants` / `ancestors` | ✓ | ✓ | ✓ (8+) | M2 |
| 12 | Window helpers | ✓ | ✓ | ✓ | M2 |
| 13 | Full-text search | ✓ | ✓ | ✓ | M2 |
| 14 | Row claiming (`update` with `lock: "skip"`) | ✓ | — | ✓ (8+) | M2 |
| 15 | Named composable queries | ✓ | ✓ | ✓ | M2 |
| 16 | Views and materialized views, section 5.7 | ✓ | views | views | M1 |

## 14. Errors

```ts
const err = OkmError.from(e);   // any thrown value

err.kind        // "unique"
err.category    // "conflict"
err.summary     // "Unique violation on users.email (email_taken)"
err.fields()    // { email: "email_taken" }
err.toHttp()    // { status: 409, body: { code, reason, fields } }
err.log()       // structured, without row values
err.retryable   // false
```

| Category | Kinds | Default status |
|---|---|---|
| `input` | invalid, not_null, check, foreign_key | 422 |
| `conflict` | unique, exclusion, conflict | 409 |
| `not_found` | not_found, not_unique | 404 |
| `forbidden` | forbidden | 403 |
| `transient` | serialization, deadlock, lock_timeout, timeout, cancelled, unavailable | 503 (retryable, except `cancelled`) |
| `internal` | schema_drift, driver, read_only, outcome_unknown | 500 |

`outcome_unknown` (OKM1401) means a commit or batch was sent and its result never arrived, so the write may or may not have happened; it is never retried automatically (`retryable: false`) and its `fix` says to check by an idempotency key. `OkmError` also carries `fix` (a structured, applicable suggestion, for people and coding agents) and, for unknown tables, fields, presets and options, a nearest-name hint ("did you mean `dueAt`?"). Every OKM code has a documentation page (cause, fix, example) generated from the error registry.

```ts
const r = await scoped.users.insert(input).safe();
if (!r.ok) return r.error.match({
  input:    (e) => form(e.fields()),
  conflict: (e) => form(e.fields()),
  _:        (e) => e.toHttp(),
});

if (OkmError.is(e, "unique", "users")) { /* e.columns typed to users */ }
```

- Row values never enter errors unless `connect({ errors: { includeValues: true } })` (development).
- Statuses are overridable in `connect()`; categories grow only when real use shows a need.
- Per-operation narrowing of possible categories is kept only if it passes the type budget (M0 spike).

Code ranges: OKM1000 schema · 1100 queries and capabilities · 1200 validation · 1300 mapped database errors · 1400 transactions · 1500 migrations · 1600 typed SQL · 1700 tenancy and policies · 1800 drivers and versions · 1900 CLI. `okm doctor <code>` explains any code.

## 15. Transactions and batches

```ts
await scoped.tx({ isolation: "serializable", retry: 3, timeout: "5s" }, async (t) => {
  const list = await t.lists.insert({ name: "Inbox" });
  await t.tasks.insert({ listId: list.id, title: "Welcome" });
  t.afterCommit(() => sendWelcomeEmail(list.id));
});

await scoped.batch([
  scoped.tasks.insert({ listId, title: "A" }),
  scoped.tasks.update({ where: { id }, set: { position: 2 } }),
]);
```

- Row locks on reads: `find({ lock: "update" | "share", wait: "nowait" | "skip" })` inside `tx()` only (OKM1830 outside one). `t.advisoryLock(key)` takes a transaction-level advisory lock.
- `connect({ timeouts })` keys: `acquire` (waiting for a connection), `statement`, `transaction`, `idleInTransaction`. Cancelling a call inside `tx()` fails the transaction and rolls it back; cancelling after completion has no effect. Server notices reach `hookm.onNotice`.
- Every timeout (statement, transaction, batch) is kind `timeout`; `cancelled` arises only from the caller's `signal` and is never retried (D124).
- Cancellation and timeouts: every operation accepts `{ signal, timeout }`; an aborted call cancels the statement where the driver has `cancel`, and fails as kind `cancelled` (category `transient`, never retried). `connect({ timeouts })` sets ceilings.
- `tx()` exists only on drivers with `transactions: "interactive"`; `batch()` exists on every driver and is atomic (batch contract below).
- A transaction is bound to the primary and to one reserved connection for its whole life (section 15.2). Nested `tx()` become savepoints on the same connection; context is preserved.
- Retry only on `transient` errors and only when declared; `outcome_unknown` is never retried.

**Batch contract.** `batch(ops)` runs the operations as one atomic unit on the primary.

- All commit or none does; results come back in the order given. Operations are independent: none consumes another's result (use `tx()` for that).
- The guarantee is part of the Driver contract, not a capability: `DriverPool.batch` is a required member and an adapter that cannot provide exactly this guarantee is not an OKModel driver (`okm driver test` fails). Interactive drivers implement it as `BEGIN … COMMIT` on a reserved connection; batch-mode drivers use their native atomic call (Neon HTTP transaction, D1 `batch`). `tx()` is the only difference between the two, and it is gated by the `transactions` flag.
- A failing statement rolls the whole batch back; the error is the mapped database error and carries `batchIndex`, a `number`, or `null` when the failure happens at commit (a deferred constraint); the whole batch is then rolled back.
- Isolation is the database default. The contract promises atomicity and statement order, nothing more; conformance assumes nothing more. Non-transactional effects (sequence values) are not rolled back, as documented for `tx()`.
- `signal` and `timeout` apply to the whole batch. Where the driver can cancel, the batch rolls back (a timeout is kind `timeout`, an abort kind `cancelled`). Where it cannot (an HTTP request already sent), an abort or a lost response yields `outcome_unknown` (OKM1401), never a claim of rollback.
- Inside `tx()` a batch runs on a savepoint of the transaction connection: a failure rolls back to it and throws; the transaction survives if the caller handles the error. `DriverConnection.batch` on a connection with an open transaction always uses a savepoint and never commits the outer transaction (conformance test).
- A batch requires the primary; `.replica()` on it fails with OKM1840.
- The `batch.atomic` conformance suite runs on every adapter: all-or-nothing on success and on a failure at each position, failure index, deferred constraints, cancellation, timeout, batch inside `tx()`, connection loss mid-batch (`outcome_unknown`), and sequences not rolled back.

### 15.1 Topology, routing and consistency

A Target has a topology: exactly one primary endpoint and any number of replica endpoints. Replicas serve the same catalog and dialect, never separate catalogs; their driver capabilities may differ. Migrations run against primaries only. The primary is its own class of endpoint with its own pool and semantics; it is never "replica zero" of a read pool. With no replicas configured, every operation goes to the primary.

```ts
export const db = connect(
  { primary: url, replicas: [{ url: r1, weight: 2 }, r2] },
  { schema: appSchema, routing: { select: "weighted", consistency: "session", fallback: "primary", maxLag: "5s" } },
);

await db.tasks.find({ limit: 50 });                       // automatic: a consistent replica, else the primary
await db.tasks.find({ limit: 50 }).primary();             // the primary is required
await db.tasks.count().replica({ consistency: "eventual" });        // a replica is required; staleness accepted
```

| `routing` key | Default | Meaning |
|---|---|---|
| `select` | `"weighted"` | strategy over eligible replicas: `weighted`, `roundRobin`, `leastConnections`, `latencyAware`, or a function |
| `consistency` | `"session"` | `"session"`: reads are never older than the session's committed writes; `"eventual"`: no watermark, only `maxLag` applies |
| `fallback` | `"primary"` | automatic reads with no eligible replica go to the primary, or fail (`"error"`, OKM1844) to protect the primary from read load |
| `maxLag` | none | eligibility filter on replica lag, `"5s"` or `"16MB"` |
| `probe` | `"1s"` | interval of the background health and position probes |

A replica entry is a URL or `{ url, weight?, name?, pool? }`.

**Routing rules.**

1. **Requires the primary:** writes, `batch`, locking reads, advisory locks and anything inside `tx()`. Every other read is eligible.
2. **Automatic.** With replicas configured, an eligible read is routed by candidate filtering then selection. If no replica is eligible it follows `fallback`.
3. **`.primary()`** (reads) requires the primary and bypasses selection.
4. **`.replica(opts?)`** requires a replica. Session consistency still applies unless `{ consistency: "eventual" }`. If no replica is eligible it fails with OKM1843 and never reads the primary; this includes a topology with no replicas (its `fix` says to configure one or drop the constraint). It is absent from the types of primary-required operations and fails at runtime with OKM1840.
5. **One operation, one endpoint.** All statements of an operation (a `find` with includes, a multi-statement snapshot read) run on the endpoint chosen for it. A transport failure before any result re-routes the operation once among eligible endpoints (never to the primary for `.replica()`).
6. **Internal read-only transactions** that OKModel opens for an operation (snapshot reads, the `rls` context) are part of that operation and follow its routing. Only user `tx()` and writes require the primary.
7. **Pages of a cursor are separate operations.** Each is consistent with the session position; they are not one snapshot.

| Call | Endpoint | If no replica is eligible |
|---|---|---|
| write, `batch`, locking read, advisory lock, anything in `tx()` | primary | none needed |
| read, no constraint, replicas configured | replica (automatic) | primary, or OKM1844 with `fallback: "error"` |
| read `.primary()` | primary | none needed |
| read `.replica()` | replica | OKM1843 |
| no replicas configured | primary | `.replica()` fails with OKM1843 |

**Candidate filtering, then selection.** Eligibility and choice are different steps and never merge into one strategy:

```text
all replicas → health → consistency and lag → capacity → selection strategy → one replica
```

- **Health:** a probe (`SELECT 1` plus the replay position) on each replica every `probe`; consecutive failures open a circuit, and the replica is re-probed with backoff.
- **Consistency:** the replica's replay position must reach the session watermark; `maxLag` applies as well. Lag is a constraint, not a strategy.
- **Capacity:** a replica whose pool is saturated is skipped for automatic reads.
- **Strategy:** chooses among the survivors from weight, in-flight count (`stats()`) and observed latency (EWMA). `weighted` with equal weights is the default and behaves as smooth round-robin. A function `select(candidates, ctx)` receives `{ name, weight, inflight, latencyMs, lag }` for each candidate and returns one.

**Consistency by commit position.**

- After a write commits, the session watermark becomes the primary's WAL position read **after** the commit, on the committing connection. PostgreSQL does not return a commit LSN to clients, so this is `pg_current_wal_insert_lsn()`: an upper bound of the commit record's LSN, hence safe, occasionally stricter than needed. Reading it inside the transaction would be wrong: it gives the start of the commit record, which a replica can reach before it has applied the commit; `pg_current_wal_lsn()` is also wrong under `synchronous_commit=off`. The read is sent on the same connection immediately after commit; sending `COMMIT; SELECT pg_current_wal_insert_lsn()` as one simple-query message is evaluated in P13 and P63, otherwise it costs one extra round trip. It applies only when replicas are configured and `consistency` is `"session"`. M0 confirmed the mechanism (the after-commit value was 40 bytes past the start of a 34-byte commit record; 0 read-your-writes violations); the extra fallback rate under write load is measured in P64 (D121).
- A replica may serve a read for a session when its replay position is at or beyond the watermark. Replay positions only move forward, so the last observed value (from a probe or an earlier check) is a safe lower bound: if it satisfies the watermark no round trip is needed; otherwise one on-demand `pg_last_wal_replay_lsn()` check runs, then the next candidate or the fallback.
- If the position read fails after a successful commit, the session is marked `position unknown` and its reads go to the primary until its next successful position read.
- The watermark is monotonic per session. A read issued after a write's promise resolved sees that write; reads concurrent with an in-flight write get no guarantee. `db.for()` clients each have a session; the root client and `db.unscoped()` share one client-wide watermark, which is conservative.
- `maxLag` in time is computed from the replica's replay timestamp only while its replay position is behind the primary's; a caught-up replica has lag zero, so an idle primary does not make replicas look stale.
- **Capability gate:** reading positions needs `replication.position` on the engine and the role's privileges, detected per endpoint at connect. Without it a session that wrote reads from the primary (automatic) or fails with OKM1843 (strict); a stale replica is never used silently. `consistency: "eventual"` needs no positions.
- Carrying a session's position across processes (a cookie or header) is deferred (section 25).

**Inspection:** `inspect()` shows the endpoint and the reason: `primary-required`, `constraint:primary`, `constraint:replica`, `auto:<name>`, or `fallback:<no-replicas | unhealthy | behind | position-unknown | saturated>`.

### 15.2 Pools, connection affinity and target resolution

- **One pool per endpoint.** The primary has its own pool, sized independently of the replicas (`connect({ max })` sets the default; a replica entry's `pool` overrides it). Endpoint selection (the router picks an endpoint) and connection selection (the pool picks a connection) are separate steps; the router sees pool statistics only as a signal.
- **Nothing above the pool sees a connection.** A query resolves to an endpoint and never to a URL, a pool or a connection.
- **Exhaustion:** acquiring a connection waits up to `timeouts.acquire`, then fails with OKM1846 (kind `timeout`, category `transient`). It never spills into another endpoint's pool.
- **Transaction affinity.** `tx()` reserves one connection from the primary pool with `reserve()`; every statement of the transaction, its savepoints and the batches inside it run on that connection; it is released on commit, rollback or cancellation, and a callback that never settles is bounded by `timeouts.transaction`. A transaction is not subject to replica selection.
- **Target resolution (M5).** A Target's connection configuration comes from its resolver: the registry for tenants, `defineConfig` for the migration Target. Pools are keyed by the resolved configuration and capped (`tenancy: { registry, maxOpenTargets, idleTimeout }`); idle pools are evicted least-recently-used, pools with a reserved connection never. If opening a connection fails authentication (SQLSTATE 28P01 or 28000), the Target is re-resolved once and its pool replaced, so credential rotation needs no restart; the old pool drains. An unknown tenant or a failing resolver fails with OKM1845.

## 16. Typed raw SQL

```ts
const overdue = await scoped.sql`
  select l.id, l.name, count(t.id)::int as overdue
  from lists l join tasks t on t.list_id = l.id
  where t.due_at < now() and t.completed_at is null
  group by l.id, l.name
`.as("overdueByList");
```

- Types recorded in `okm.lock.json` by `okm build` via driver `describe`; stale entries fail CI (OKM1601).
- Tenancy and deletion-trait filters apply when tables are recognised; unverifiable statements on tenant tables fail closed (OKM1702) unless `.trusted("reason")`.
- `sql.raw(text, "reason")` requires a reason.

## 17. Generics

```ts
class Crud<N extends TableName> {
  constructor(protected db: Client, protected name: N) {}
  list(opts: FindOpts<N>)            { return this.db.table(this.name).find(opts); }
  get(id: Id<N>)                     { return this.db.table(this.name).one({ where: { id } }).required(); }
  create(data: Insert<N>)            { return this.db.table(this.name).insert(data); }
  update(id: Id<N>, data: Update<N>) { return this.db.table(this.name).update({ where: { id }, set: data }); }
}

class ArchiveCrud<N extends TablesWith<"archivable">> extends Crud<N> {
  archive(id: Id<N>) { return this.db.table(this.name).archive({ where: { id } }); }
  restore(archiveId: string) { return this.db.table(this.name).restore({ archiveId }); }
}

function byOwner<N extends TablesWithColumn<"ownerId">>(db: Client, name: N, ownerId: string) { … }
```

`db.table(name)` returns a named `TableClient<N>`; `Tx` is `Client`; a CI suite of common generic patterns must compile without casts.

## 18. Extension

| Mechanism | Covers |
|---|---|
| Traits | table level: fields, presets, methods, write behavior |
| Hookm in `connect({ hookm })` | runtime observation, events only, cannot change queries: query, result, error, transaction phase |
| `t.custom()` | column types with codecs |
| Extensions in `schema({ extensions })` | database extensions (built-in, npm, project): types, operators, functions, index methods, lifecycle (section 4.1) |
| Tagged helpers | custom operators and SQL functions: `operator("near", (col, v) => sql`...`)` |

Which one to use:

| Need | Use |
|---|---|
| add columns and behavior to many tables | trait |
| a named, reusable query refinement on one table | preset |
| automatic isolation between tenants | tenancy |
| observe queries, results, errors, transactions | hook (cannot change behavior) |
| use a database extension (pgvector, pg_trgm) | extension |

```ts
export const tracing = (onSpan: (s: Span) => void) => hook({
  onQuery: (q) => { … },            // q.fingerprint, q.tables, q.sql — read-only
  onResult: (r) => { … },
  onError: (e) => { … },
  onNotice: (n) => { … },           // server-generated messages; events only
  onTransaction: (t) => { … },      // t.phase: "start" | "commit" | "rollback"; events only, no `next`
});

connect(url, { schema: appSchema, hookm: [tracing(onSpan)] });
```

- Hookm are read-only in 0.x.
- Internally, traits, custom types, operators, hookm, dialects and drivers register through one contribution protocol with declared requirements. It stays internal until 1.0 so it can change; every built-in feature uses it.
- Community dialects and drivers are validated by the conformance suite.

## 19. Migrations

### 19.1 Planning

- Diff from DDL snapshots to SQL; graph history with commutativity checks.
- **Renames are declared** (`.renamedFrom()`, `renamedFrom` table option). The planner never prompts; an ambiguous drop-and-add fails with OKM1530 and shows the line to add; stale declarations are reported by `okm check`.
- **Expand/contract classification:** every migration is tagged `expand` (additive, old code keeps working) or `contract` (removes or changes). Classification is advisory, backed by the linter and the previous-catalog check; it is not a proof of application behavior.
- **The plan shows locks:** each step lists the lock it takes and, with a connected database, an estimate from `pg_class` statistics ("ACCESS EXCLUSIVE on tasks, about 4.2M rows; safe rewrite applied").
- **Safe rewrites generated automatically:** concurrent index create/drop outside transactions; constraints as `NOT VALID` + `VALIDATE`; `SET NOT NULL` via a validated check constraint; volatile defaults split from column creation; unique constraints built from concurrent unique indexes.
- **Linter** (OKM1510–1549), seeded from Squawk, strong_migrations and Atlas categories: backward-incompatible, destructive, data-dependent, locking, type preferences (`timestamptz`, `text`, identity, `jsonb`). Overrides need a written reason. Data statements in migration files other than `backfill()` steps are flagged (OKM1542): required rows belong in `reference`, which provisioning can reproduce (section 19.6).

### 19.2 Applying

- Runs as a deploy-pipeline step, never at application boot; refuses known pooler URLs unless told otherwise.
- **One apply per target at a time.** `apply` takes a session-level advisory lock on the target for its whole run; a second concurrent apply fails at once with OKM1522 instead of racing (the direct connection it requires is what makes a session lock reliable).
- Sets `lock_timeout` and `statement_timeout`; retries lock timeouts with backoff.
- **Failure inside one migration.** A migration runs atomically in one transaction wherever PostgreSQL allows it. Steps that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE` before use, `VACUUM`) are split out by the planner as separate steps and marked so in the plan. Every step records a checkpoint in the target's history. On failure the run stops at the failing step, reports it and leaves the target at its last checkpoint; running `apply` again resumes from that step and repeats nothing that finished. A failed concurrent index leaves an invalid index; the resume step drops it and rebuilds it.
- **Forward-only.** There are no down migrations: they are rarely correct on real data, above all after a `contract`. Recovery is a new forward migration, or rolling the application back, which is safe because `expand` migrations keep the previous release working. `contract` is applied only after the new release is confirmed, and on protected targets it needs `--allow-protected`.
- `backfill()` is a migration step of its own class (data), planned and shown in `okm migrate plan`: batched, resumable from a stored checkpoint, tenant-aware (iterates tenants), run under `statement_timeout` with a rate limit. Expand/contract and adding a `NOT NULL` tenant key both use it.

### 19.3 Drift

**Comparison pipeline:** introspect, then the dialect's `normalize`, then compare. Expressions that the database rewrites (defaults, checks, generated columns, view and function bodies) are not compared as text: the declared definition is applied to a scratch database and read back, and both sides go through the database before comparing.

The catalog hash is computed over the normalised structure (D117). Fast path: each migration stores the catalog hash in `okm_meta`; `connect()` compares it with the code's catalog hash in one cheap query and runs the detailed check only when they differ. `okm build` also emits a serialised catalog (`.okm/catalog.json`) that production bundles can load instead of rebuilding the catalog at start (cold start).

The startup check is a compatibility check: the database may be ahead of the code by `expand` migrations; ahead by a `contract` migration, or behind, fails with OKM1520. A database with no recorded catalog hash skips the check, so an existing database can adopt OKModel. `connect({ requireMeta: true })` makes that missing hash OKM1520. The option is explicit: the target name and `NODE_ENV` do not turn it on. A production connection sets `requireMeta`.

`okm migrate check` also verifies that the previous release's catalog (stored with each migration) is satisfied by the new schema. This establishes schema-level compatibility with the previous release's OKModel catalog (columns, types, nullability and constraints the old catalog relies on); it does not prove application behavior. Any violation must be classified `contract`.

### 19.4 CLI

| Command | Does |
|---|---|
| `okm build` / `okm dev` | validate schema, emit `.okm/`, update typed-SQL signatures; `okm dev` starts a local PGlite database in `.okm/dev-db` when no dev target is configured (real Postgres, no Docker) |
| `okm catalog export [--json]` | write the catalog snapshot (used by dependent catalogs, docs and tooling) |
| `okm check` | capabilities, unlisted tables, validation conflicts, stale renames, lint |
| `okm migrate plan <name>` | plan, classify, lint |
| `okm migrate apply` | apply with timeouts, retries, checkpoints and resume; on an empty target it provisions from the current snapshot (section 19.6). Flags: `--target <name>` (required when several targets exist), `--allow-protected`; with many targets also `--class shared\|tenant`, `--canary <n>`, `--concurrency <n>`, `--max-failures <n>` (section 19.5) |
| `okm migrate status` | per target: version, catalog hash, state (current, behind by `expand`, behind by `contract`, ahead, failed at step), with a separate `protected` column |
| `okm migrate check` | CI: commutativity, lint, stale lockfile, snapshot ↔ replayed history equivalence (OKM1521) |
| `okm generate` | produce migration SQL from the schema, including extension lifecycle; no TS is generated |
| `okm push` | prototype sync; blocked on a `protected` target (section 19.7). A target named `production` is not blocked unless that entry sets `protected` |
| `okm pull` | introspect an existing database into table files and a schema (M2) |
| `okm ext list\|check\|test\|scaffold` | list supported and installed extensions against the connected server; check versions; conformance test; scaffold a definition (M2) |
| `okm seed <file>` | seeds with factories |
| `okm import drizzle <path>` | convert a Drizzle schema (M2) |
| `okm doctor [code]` | explain a code or diagnose the project |
| `okm upgrade` | codemods between 0.x releases |

### 19.5 Targets

The migration engine works on a list of Targets from the start (a list of one in M1): catalog → plan → `TargetRunner` → Target → resolver → connection (the target's primary, with the migration role).

- **A Target is a logical destination** (name, class, protection flag, namespace binding), never a connection (invariant H). Plans and run state contain Target names, not URLs, credentials or tenant connection details. The runner resolves each Target at execution time: `defineConfig({ database })` for the single target, the tenant registry for tenants. Credential rotation, tenant discovery and topology changes therefore need no change to a plan.
- **Two classes.** `shared` (one) and `tenant` (many, under schema-per-tenant or database-per-tenant). Expand applies shared, then tenants; contract applies tenants, then shared, because tenant tables may reference shared tables.
- **History per target**, so each tenant records its own version (section 19.6 for new targets).
- **One runner** (`TargetRunner`) serves `migrate apply` and `backfill()`: bounded concurrency, retries, checkpoints, per-target failure isolation and a per-target report. Run state is stored in the control database (`database` in `defineConfig`), so it survives across pipeline runs. Every step calls the protection policy for its Target (section 19.7).
- **Runtime compatibility is per tenant:** a tenant behind by `expand` migrations works; behind by a `contract` migration fails closed for that tenant only (OKM1520). The check runs at a tenant's first connection (the catalog hash fast path) and is cached.
- Migrations never run against a replica.

**Rollout control (many targets, M5).** The default is every target. The scope and pace are controlled explicitly:

| Flag | Meaning |
|---|---|
| `--target <name>` (repeatable) | only these targets; a tenant target is named `tenant:<id>`, the shared and named environment targets by their names |
| `--class shared\|tenant` | only one class |
| `--canary <n>` | apply to the first `n` tenants in registry order and stop; contract steps are skipped and reported as pending; a later plain `apply` continues with the rest from their checkpoints |
| `--concurrency <n>` | targets in parallel; the default is 2 for `schemaPerTenant` (tenants share one catalog and its locks) and 8 for `databasePerTenant` |
| `--max-failures <n>` | stop scheduling new targets after `n` failures (default 3), so a migration that breaks every tenant is halted early; unstarted targets stay pending |

- **Contract gating.** A `contract` step applies to a tenant only if that tenant already has every earlier migration. The shared `contract` step is evaluated against the whole registry, not the scope: it runs only when every registered tenant has the migration. Any partial scope (`--canary`, `--class`, a `--target` subset) skips contract steps and reports "contract pending (N tenants not at this migration)"; if any tenant failed or is pending, the shared step does not run (D123). No tenant is left referencing something already removed.
- **Second pass.** When the run finishes the runner reads the registry again and processes tenants created while it was running.
- **Failures are isolated and resumable.** A failed target is recorded with its step and error; the exit code is non-zero; a later `apply` processes only failed and pending targets.
- `okm migrate status` shows all targets in one table, with the same states used by the runtime check.

### 19.6 Provisioning a new target

A new Target is created from the current provisionable snapshot, not by replaying history (invariant J).

- Every migration stores the full DDL snapshot of the catalog after it; the latest is the provisionable snapshot of head.
- **`okm migrate apply` on an empty target** (no `okm_meta`, nothing in its namespace) installs the head snapshot and the `reference` rows, records the head catalog hash and a `provisioned@<migration id>` entry in the target's history, and runs no expand, backfill or contract step. A target that is not empty and has no history is refused (OKM1851).
- The programmatic entry `provision(target)` from `okmodel/migrate` (L4) serves signup flows; it obeys the same rules and uses the registry's `migration` role. Under schema-per-tenant OKModel creates the schema; under database-per-tenant the registry's `create(id)` creates the empty database first.
- **The snapshot is valid from empty by construction and by test.** `okm migrate check` applies the whole history to one empty database and provisions from the snapshot on another, introspects both through the normalisation pipeline, and requires them to be equal to each other and to the catalog (OKM1521).
- **Reference data.** Rows the application needs to exist are declared with the table option `reference` (section 6.2): insert-if-missing by key, applied by provisioning and by every `migrate apply`, never updating or deleting, classified `expand`. Data steps that transform existing rows are `backfill()`; they are not replayed on an empty target because it has no rows.

### 19.7 Protected targets

`protected` means that only additive, reversible-by-design work runs without a deliberate decision. It does not mean no schema change is ever allowed. One function, `assertTargetPolicy(target, operation)`, in L4 is called by every entry point: the CLI, the migration engine, `backfill()`, `okm seed`, the `TargetRunner` and `provision`. No command bypasses it (`protected.policy` enumerates every operation class against protected and unprotected targets).

| Operation class | On a protected target |
|---|---|
| read-only: `plan`, `status`, `check`, drift, `verify`, `pull`, `catalog export`, `inspect` | allowed |
| `expand` migration (including extension add and upgrade) | allowed |
| `reference` rows | allowed (additive) |
| `provision` | allowed only on an empty target |
| `contract` migration (including extension move and remove) | blocked |
| a migration step without a classification (raw SQL) | blocked (treated as `contract`) |
| `okm push` | blocked |
| `backfill()` | blocked |
| `okm seed` | blocked |
| history repair (baseline, mark as applied) | blocked |

- Blocked operations run with `--allow-protected`. It is a per-invocation flag (and the `allowProtected` option of the engine API); there is no environment variable that implies it, and in a multi-target run it applies only to the selected targets and is printed in the report.
- A blocked step fails that Target with OKM1850 and the runner continues with the others (failure isolation).
- Protection never affects the application's runtime `connect()`. It is a property of the physical database (D122): under `schemaPerTenant` all tenants share one database, so protection must be uniform and a mixed registry fails with OKM1852; per-tenant protection requires `databasePerTenant`.

### 19.8 Environments and previews

An environment is a named Target. Nothing about an environment is inferred from `NODE_ENV` or a URL.

In 0.1, `okm migrate apply` replays migration files. Installing the head snapshot on an empty target (section 19.6) arrives with provisioning in P53A. A preview and a rehearsal in 0.1 both replay history.

- **Named targets.** `production`, `staging` and `preview` are entries of `targets` (section 3.1); protection is declared on the entry that needs it. A pipeline names its target explicitly (`okm migrate apply --target production`), so a preview job cannot act on production by omission (OKM1853).
- **Production is declared protected.** A target named `production` is not protected by its name. Set `protected: true` on that entry. `connect({ requireMeta: true })` is the matching runtime check for a missing `okm_meta`; it is also explicit and is not inferred from the name.
- **Aliasing guard.** `okm check` and `okm doctor` compare the resolved hosts and database names of all targets and fail when targets that resolve to the same host, port and database differ in protection (OKM1852); two unprotected targets may share a database.
- **Preview environments.** One ephemeral database or schema per pull request, created by infrastructure (Neon branching, `CREATE DATABASE`, a container; the OKModel CI recipe uses Docker Compose). Steps: create the empty database, `okm migrate apply --target preview` (installs the head snapshot and `reference` rows without replaying history, section 19.6), optionally `okm seed`, deploy the application with the preview URL. Deleting it when the pull request closes is the infrastructure's job: OKModel never drops a database.
- **Migration rehearsal.** To test pending migrations against realistic data, clone or branch the production database, register the clone as a target, and run `okm migrate apply --target rehearsal`. The report gives per-step duration, the locks taken, retries and failures, on the real history and data shape rather than on an empty snapshot. It is a recipe over existing commands, not a separate command.
- **Reproducibility.** A preview built from the head snapshot and a rehearsal built by applying history must reach the same catalog; `okm migrate check` already proves that equivalence (OKM1521).
- The official GitHub Action (M2) posts the plan, classification and locks on the pull request and can drive the preview recipe.

## 20. Testing

```ts
import { testing } from "okmodel/testing";
import { pglite } from "okmodel/pg/pglite";

const t = await testing(appSchema, { driver: pglite() });
const f = t.factories({
  users: (x) => ({ email: x.email(), name: x.name() }),
  tasks: (x) => ({ title: x.words(3), listId: x.ref("lists") }),
});

test("tenant A cannot read tenant B", async () => {
  const [a, b] = await f.tenants.createMany(2);
  await f.tasks.create({ tenantId: b.id });
  expect(await t.db.for({ tenantId: a.id }).tasks.count()).toBe(0);
});

test("today view runs one query", async () => {
  const tenant = await f.tenants.create();
  const user = await f.users.with({ tasks: 20 }).create({ tenantId: tenant.id });
  await t.expectQueries(1, () => loadToday(t.db.for({ tenantId: tenant.id }), user.id));
});
```

`testing` ships a cross-tenant isolation check that runs every table's basic queries under two tenants and fails on any leak. The `okmodel/testing` name is reserved. It is not an export in 0.1. Factories and the isolation check arrive in 0.4 (P54).

**Testing principles.** Tests assert observable results, state changes, errors and emitted events of production code. The database is never mocked in ORM tests (PGlite or real Postgres); mock only external boundaries. File-content checks are for shipped artifacts, exports and cross-runtime contracts, never for source strings.

**Repository checks (CI).** `docs:check` (section references, error codes against the registry, milestone consistency), `publint` and `arethetypeswrong` for the exports of an ESM-only package across Node, bundlers and runtimes (D112), an API report that fails on accidental public-API changes, no runtime dependencies in the core, no `node:*` imports in the core, the layer import graph (`layers-check`), and a size budget.

**Capability matrix.** The registry and the conformance suite are tied together in CI: every capability a driver declares has at least one conformance test that the driver passes, and a test that needs an undeclared capability is skipped explicitly. A declared capability without a test fails the build. `emulated` features run the same tests (the result is checked, not the mechanism). The docs' compatibility table is generated from these results, not written by hand.

**Driver conformance suite** (`okmodel/conformance`): the same semantic tests against any adapter — null semantics, codecs (numeric, bigint, timestamps, JSON), defaults and generated values, `RETURNING`, transactions, the atomic `batch` contract (section 15), connection reservation and release, error mapping, constraints, pagination and cursors, locking, concurrency, and the small-API semantics table (section 12).

**Topology tests.** Consistency is tested on real streaming replication (a primary and replicas in CI service containers, replay paused with `pg_wal_replay_pause()`). Router and selection logic may run over several independent PGlite instances as endpoints, with replication state supplied through the documented `ReplicaState` seam; no test mocks the database itself. First-party adapters must pass it in CI; community adapters run `okm driver test` (M2).

**Migration verification:** apply the full history to an empty database; after each migration, introspect and compare with the catalog (zero diff); check the previous release's catalog against the new schema. Comparison uses the normalisation pipeline of section 19.3.

## 21. Guards

| Guard | Enforced by | Code |
|---|---|---|
| Unknown table, FK problems, duplicate names | types + startup | OKM1020–1023 |
| Table file not in schema | `okm check` | OKM1024 |
| More than one `Register` | `okm check` | OKM1025 |
| Dependency cycle in the catalog | schema | OKM1026 |
| Catalog document this version cannot read (unknown version or malformed) | load | OKM1027 |
| Invalid column definition: length, precision, scale, array rank, interval qualifier, empty or duplicate picklist or enum values | schema | OKM1060 |
| A table or schema option that exists in the types but is not available in this version (reserved slot) | schema | OKM1061 |
| A codec rejects a value (not numeric text, not a valid temporal value, wrong shape) | runtime | OKM1210 |
| Validation in two places | types + `okm check` | OKM1030 |
| Preset name collides with a client method | types | OKM1040 |
| Trait field conflict | schema | OKM1012 |
| `find` without `limit` | types | OKM1101 |
| Unfiltered `update`/`delete` | types + runtime | OKM1102 |
| Undeclared non-restrict FK to a table-strategy archivable table | schema | OKM1051 |
| `archive`/`restore` on a non-archivable table (dynamic call) | runtime | OKM1052 |
| `upsert` target not unique | types | OKM1104 |
| To-many include without `limit` | types | OKM1105 |
| Feature needs a newer engine than `requires` allows | types | OKM1110 |
| Unknown field name at runtime | runtime | OKM1120 |
| Object where a value is expected | runtime | OKM1121 |
| Cursor used with a different order | runtime | OKM1130 |
| Composition breaks a core invariant (final safety verification) | runtime | OKM1190 |
| Multi-statement read requested inside `READ COMMITTED` with no single-statement plan | runtime | OKM1191 |
| Unsafe migration without reason | CI | OKM1510 |
| Drift beyond expand compatibility | startup | OKM1520 |
| Another apply holds the target's lock | CLI / engine | OKM1522 |
| Snapshot provisioning differs from replayed history | `okm migrate check` | OKM1521 |
| Ambiguous rename | plan | OKM1530 |
| Picklist value removal with data | plan | OKM1541 |
| Data statement in a migration outside `backfill()` | lint | OKM1542 |
| Stale typed-SQL signature | CI | OKM1601 |
| Commit or batch outcome unknown (result never received) | runtime | OKM1401 |
| Tenant table without context | types | OKM1701 |
| Unverifiable raw SQL on tenant table | runtime | OKM1702 |
| Changing the tenant key | types + runtime | OKM1704 |
| Global table referencing tenant table | `okm check` | OKM1705 |
| Tenant index not led by the key | lint | OKM1706 |
| RLS with owner or superuser role | connect | OKM1707 |
| Schema/driver dialect mismatch | types | OKM1801 |
| Server does not satisfy `requires` | connect | OKM1802 |
| Server is older than PostgreSQL 15 and `requires` does not name that older major | connect | OKM1803 |
| Extension builder used but not declared | build | OKM1810 |
| Declared extension unavailable on the server | plan / `okm doctor` | OKM1811 |
| Feature not in the declared versions | build | OKM1812 |
| Extension defined twice | build | OKM1813 |
| Extension downgrade, move of a non-relocatable extension, or drop with dependents | plan | OKM1814 |
| Identifier fails the rules (length, NUL, control characters, unquoted reserved word) | runtime | OKM1122 |
| Hidden field allowlisted in a filter or sort allowlist | build | OKM1123 |
| Operator does not apply to the column type | types + runtime | OKM1124 |
| View over tenant tables without the tenant key or `global` | `okm check` | OKM1820 |
| Incompatible replace needs recreate of dependents (shown, never `CASCADE`) | plan | OKM1821 |
| `REFRESH CONCURRENTLY` without a unique index | plan | OKM1822 |
| `SECURITY DEFINER` function without `search_path` | lint | OKM1823 |
| plpgsql function without `dependsOn` | build | OKM1824 |
| Application role lacks privileges on a managed object | connect / `okm doctor` | OKM1825 |
| Row lock on `find` outside a transaction | types + runtime | OKM1830 |
| `.replica()` on an operation that requires the primary, or inside `tx()` | types + runtime | OKM1840 |
| External object differs from the owner's exported catalog | `okm check` / CI | OKM1841 |
| Foreign key across databases | build | OKM1842 |
| `.replica()` with no eligible replica (unhealthy, behind the session, position unavailable, none configured) | runtime | OKM1843 |
| Automatic read with `fallback: "error"` and no eligible replica | runtime | OKM1844 |
| Target cannot be resolved (unknown tenant, resolver failure) | runtime / CLI | OKM1845 |
| Connection acquire timeout on an endpoint's pool | runtime | OKM1846 |
| Operation blocked by the protection policy on a `protected` target without `--allow-protected` | CLI / engine | OKM1850 |
| Provisioning a target that is not empty | CLI / engine | OKM1851 |
| Targets resolving to the same database differ in protection, or tenants of one `schemaPerTenant` database differ in protection | `okm check` / `okm doctor` | OKM1852 |
| Several targets configured and none named (`--target`) | CLI | OKM1853 |

## 22. Non-goals

- Identity map, unit of work, dirty tracking, lazy loading or hidden entity state. Rows are plain data; queries and transactions are explicit.
- Nested writes as the default way to write related rows. Related writes use explicit transactions or `batch`.
- An authorization framework. Tenancy and row policies isolate data; permissions belong to the application.
- A lowest-common-denominator API. Dialect packages expose native features; `okmodel/sql` is an opt-in subset.
- Type constructs that do not improve DX; anything over the type budget is removed.
- A cache in the kernel.

## 23. Milestones (all 0.x)

Execution order and prompts: `okmodel-execution-plan.md`. Inside M1, work ships as release trains, each independently tested and published:

| Train | Scope |
|---|---|
| 0.1 Skeleton | tables and columns, catalog core, basic migrations, typed find/insert/update/delete, postgres.js and PGlite, errors, `inspect()`/`sql()` |
| 0.2 Safety | tagged operators, final safety verification, field exposure, tenancy (column), traits (`timestamps`, `archivable`), validation, relations and includes, presets, transactions, locks, cancellation |
| 0.3 Objects | extensions, functions, triggers, views, materialized views, roles and grants |
| 0.4 Migration depth | expand/contract, linter and safe rewrites, `backfill()`, `reference` data, drift with catalog hash, previous-catalog check, snapshot provisioning and its equivalence check, protected-target policy, isolation test, factories |
| 0.5 Topology | `connect({ primary, replicas })`, automatic read routing, `.primary()` and `.replica()`, candidate filtering and selection strategies, health and position probes, session read-your-writes by commit position, fallback policy, `routing` in `inspect()`, per-endpoint pools, topology conformance on real streaming replication |


| Milestone | Scope |
|---|---|
| **M0 — Spikes** | section 24 |
| **M1 — Thin Postgres slice** | `okmodel/pg` column types and codecs; `table()`, `schema()`, `Register`; `timestamps`, `archivable` (column strategy, full archive contract); tenancy `column` + `global`; validation; protected fields; tagged operators and runtime identifier checks; `connect()` with postgres.js and PGlite adapters; reading (find, one, page, count, exists, include, `.required()`) and writing (insert with conflict modes, update, `delete`, `archive`, `restore`); tools 1, 3, 6; `OkmError` with categories; transactions and `batch`; migrations (plan with declared renames, classification, core linter rules, apply, drift); testing with the isolation check; namespace-qualified identity with template support, named migration targets (`targets`, `--target`) with the resolver, atomic-per-migration apply with checkpoints, resume and the per-target lock, forward-only migrations, `okm migrate status`, and the protected-target policy, the Target / Topology / Endpoint / Pool / Router runtime with one pool per endpoint and connection affinity for transactions, `connect()` with a string or a topology, automatic read routing with `.primary()` / `.replica()`, replica selection and session read-your-writes by commit position, the atomic `batch` contract in the Driver contract, snapshot provisioning with `reference` data; catalog object contract with functions, triggers, views and materialized views (create/replace/drop, index ownership, `refresh` declaration, populate as a planned data step, dependency ordering, ownership, drift, typed calls and queries, view tenancy), `roles` with default privileges, `backfill()`, `{ signal, timeout }`, row locks on `find`, `.sensitive()`; extensions (`extension()` contract, lifecycle, drift, `citext`, `pg_trgm`, project-defined extensions, declare-only); CLI core; `inspect()`, `sql()` and fingerprints; final safety verification; small-API semantics and the conformance suite for both adapters; migration verification. Proven by a small reference app before M2 starts |
| **M2 — Depth** | tenancy `path`, `composite`, `rls`; `versioned`, `sortable`; tools 2, 4, 5, 7–15; `filters()`; SQL builder lane; typed raw SQL; full linter and safe rewrites; `okmodel/otel` (OpenTelemetry `db.*` conventions, fingerprint as query summary), an official GitHub Action (classification, locks and catalog conflicts as a PR comment), several catalogs on one database, `external()`, `okm catalog export`; `.stream()`; `okm pull` for database objects, plpgsql dependency verification on a scratch database, fine-grained grants; `okm pull`; programmatic schema API; `okm import drizzle`; pg, Bun and Neon adapters; dev inspector; `explain()`; extension packs (`vector`, `ltree`, `hstore`, `unaccent`, `btree_gist`, `btree_gin`, `fuzzystrmatch`, `pgcrypto`), npm definitions, `okm ext`; ownership states; `okm driver test`; `morph` |
| **M3 — SQLite** | `okmodel/sqlite`, `okmodel/sql`, SQLite adapters (D1 as a batch-mode adapter), `auditable`; PostGIS pack |
| **M4 — MySQL** | `okmodel/mysql`, mysql2 adapter, MariaDB differences, generated-column partial uniques |
| **M5 — Hardening** | studio, published budgets and benchmarks, complete docs, codemods for all 0.x breaks, schema-per-tenant and database-per-tenant strategies with the multi-target `TargetRunner`, `tenancy.registry`, target resolution with credential rotation and pool caps, tenant provisioning, and rollout control (`--class`, `--canary`, `--concurrency`, `--max-failures`, contract gating, second pass) |
| **1.0 gate** | OKE's `store.sql` running on OKModel in production and at least one other real app; published type budgets and benchmarks; stability policy; a second maintainer |

## 24. M0 spikes

M0 validates and measures the architecture; it is not another API redesign round. Every finding is classified as one of: correctness bug, specification contradiction, measurable DX problem, measurable performance problem, or genuinely missing capability. New API surface is not added because an edge case can be imagined. Priorities: object identity and dependencies (overloads, views, materialized-view lifecycle, function and trigger dependencies), deterministic hashes, migration ordering, diffing and introspection, final safety verification, statement-count guarantees, snapshot consistency, archive and restore correctness, driver conformance, compile-time and runtime overhead.

| Spike | Pass condition |
|---|---|
| Row-type strategy: inferred vs emitted `.okm/types.d.ts` | the faster one under the type measurement (D114) on the 200-table fixture becomes the default; ceilings recorded |
| `Register` across table files | autocomplete works on TypeScript 7 without circularity errors, or fall back to emitted names |
| Tagged operators | readable errors, no measurable type cost versus object operators |
| Generics suite | `Crud<N>`, `TablesWith`, `TablesWithColumn` compile without casts |
| Capability gating | readable OKM1110, no measurable type cost |
| Composite tenant FKs + tenant-scoped uniques | generated DDL correct; `EXPLAIN` uses tenant-leading indexes |
| `archivable` | column strategy: cascade, `archiveId` provenance, parent rule and unique conflicts on Postgres; table strategy: measure whether archived snapshots can follow migrations |
| Error mapping | constraint → fields and reason correct on 20 cases for postgres.js and PGlite |
| Single-statement includes | `EXPLAIN` shows index use on a realistic schema |
| Fixtures | 10/50/200/500 tables plus a realistic multi-tenant fixture; hover and error-message snapshots |
| Compile and runtime overhead | query build time and runtime overhead measured against direct postgres.js calls; ceilings recorded |
| Final safety verification | property tests: random compositions of presets, traits and filters never reach a tenant table without the tenant predicate | `safety.property` |
| Extension type inference | inference from `extension()` definitions stays within the type budget on a fixture with 10+ extensions and 200 tables; otherwise simplify the contract before freezing it |
| Extension introspection | the CI introspector produces definitions for pgvector, pg_trgm, ltree and PostGIS on Postgres 15–18 containers that type-check and emit correct SQL; naming of symbolic operators (`%`, `<->`, `<=>`) |
| Extension lifecycle | add, upgrade, drop, dependency refusal and `generate` → `push` verified on those containers |
| Catalog object family | model table, column, index, constraint, sequence, extension, view, materialized view, function, trigger, policy, domain and a partitioned table with partitions on the one contract; verify overload identity, deterministic hashes, drop-and-recreate of a view around a column change, ordered create and drop of table → trigger → function → type, scratch-database round trip reading `pg_depend`, 63-character identifier hashing, `DEFERRABLE` constraints, `NULLS NOT DISTINCT`. The catalog contract is frozen only after this passes |
| Roles and grants | migration role and app role: default privileges reach new tables; RLS with a non-owner role works end to end |
| Cancellation | `signal` cancels a running statement on postgres.js and PGlite; behavior on drivers without `cancel` |
| Capability matrix | postgres.js and PGlite against every declared capability: the registry ↔ test link holds, undeclared capabilities are gated in types and fail clearly at runtime, and the compatibility table is generated from the results |
| Namespace identity | `(namespace, name)` with static and template namespaces through snapshot, diff and plan; two catalogs in one database with an external reference and catalog export |
| Replica routing | on a primary with two replicas: automatic read routing, no operation that requires the primary ever reaches a replica (property test over writes, `batch`, locking reads, advisory locks, `tx()`), `.primary()`, strict `.replica()`, internal read-only transactions (`rls` `set_config`, snapshot reads) on a replica, one endpoint per operation, decision and reason visible in `inspect()` |
| Replica selection | health filtering and recovery, weighted distribution within tolerance, `leastConnections` under skewed load, `latencyAware` with injected latency, lag-aware eligibility, replica failure under load, primary fallback, strict failure (OKM1843), `fallback: "error"` (OKM1844), custom `select` |
| Connection pools | independent pool per endpoint (primary and each replica), acquire and release without leaks, transaction affinity (property test: every statement of a transaction, its savepoints and its batches share one connection), pool exhaustion (OKM1846, no spill into another endpoint), `reserve()` on postgres.js and PGlite |
| Commit position | on real streaming replication, verify the mechanism itself: `pg_current_wal_insert_lsn()` read after commit is at or beyond the commit LSN (compare with `pg_current_wal_lsn()`, with `synchronous_commit` on and off); single write, several writes, transaction commit, `batch`; replica caught up, behind (replay paused), all behind; monotonic replay-position cache is a sound lower bound; position read failing after commit; capability unavailable (provider without the functions or privileges); fallback; strict `.replica()`; measured cost (extra statement) and extra fallback rate under write load; time-lag computation on an idle primary |
| Target and connection | Target ≠ connection: resolver-based resolution, database-per-tenant, tenant registry resolution, credential rotation mid-run (re-resolve once, pool replaced), 200 tenants under a pool cap with LRU eviction, property test that plans and run state contain no connection details |
| Target runner | one catalog applied to 3 schemas and 3 databases: bounded concurrency, checkpoint, partial failure, resume, per-tenant compatibility, per-target history |
| Migration failure and resume | a failing transactional step rolls the migration back; a failing non-transactional step (concurrent index) stops at its checkpoint, leaves an invalid index that resume rebuilds, and repeats nothing finished; two concurrent applies: the second fails with OKM1522; forward-only recovery by a new migration |
| Rollout control | 3 schemas and 3 databases: `--canary`, `--class`, concurrency defaults, `--max-failures` halting a migration that breaks every tenant, contract gating (the shared step waits for every tenant), the second pass for a tenant created mid-run, `okm migrate status` states |
| Preview and rehearsal | preview from the snapshot on an empty database (time measured, catalog equal to replayed history); rehearsal of pending migrations on a clone of a populated database with per-step durations and locks; OKM1852 aliasing guard; OKM1853 when several targets exist |
| Provisioning | empty schema and empty database → current snapshot → head, equal to a fully migrated target (introspect, normalise, compare) under schema-per-tenant and database-per-tenant; no expand, backfill or contract step replayed; `reference` rows present; the snapshot is valid from empty (`migrate check`); a non-empty target is refused (OKM1851) |
| Protected targets | one policy test over every operation class × protected and unprotected, through the CLI, the engine, `backfill()`, `okm seed`, the runner and `provision`; per-target failure isolation |
| Batch atomicity | on every adapter (postgres.js, PGlite, and a batch-mode harness adapter over a real database; Neon in M2, D1 in M3): all-or-nothing on success and on failure at each position, failure index, deferred constraints, cancellation, timeout, batch inside `tx()` on a savepoint, connection killed mid-batch (`outcome_unknown`), sequences not rolled back |
| Migration round trip | property test: random catalog pairs A→B; the plan applied to A on real Postgres introspects to exactly B; dependency-aware recreate holds |
| Cold start and size | `schema()` build time on the 200-table fixture versus loading `.okm/catalog.json`; core size budget recorded |
| Decision gate | after M0: if inferred row types exceed the budget, emitted types become the default; the catalog contract is frozen only after the catalog-object spike passes |

**M0 outcome.** The spikes ran in P03–P08B and the evidence is `docs/m0-findings.md` (68 findings). The decision gate passed: findings that needed a decision became D116–D127 and are applied in this draft; the rest are implementation tasks in the plan. Emitted row types are the default (D120), the catalog contract is frozen (D116), and ceilings and first size budgets are recorded in D127 (core hashing is pure-TypeScript SHA-256 in L0, no `Bun` or Node globals).

## 25. Deferred directions (not scheduled)

The architecture keeps these possible; none is planned:

- A physical plan optimizer choosing include strategies from cardinality and observed performance.
- Schema modules: reusable domain packages with tables, traits and migrations (`group()` reserves the shape).
- Application impact analysis (`okm impact users.email`) from fingerprints and static references, reporting known, observed and unverifiable usages.
- Performance analysis (`okm analyze`) combining fingerprints, EXPLAIN and metadata; it suggests, never applies.
- A cache module with precise invalidation from fingerprints, table dependencies and `afterCommit`.
- Procedures, aggregates, operators, casts, event triggers, partitions and foreign tables as catalog objects (the contract accommodates them; partitions are modelled in the M0 spike).
- Tenant export and erasure (`tenant.export()`, `tenant.erase()`): the catalog knows tenant tables and the FK graph, so it computes ordering and verifies that no orphan or foreign row remains; `DROP SCHEMA` under schema-per-tenant. Planned after 1.0.
- Shard routing as a tenancy strategy.
- Carrying a session's write position across processes (a cookie or header) for read-your-writes across servers.
- A consistent-snapshot read-only `batch`.
- An MCP server for coding agents (read-only by default: catalog, `explain`, migration plans without apply), as a separate package outside the core; not scheduled.
