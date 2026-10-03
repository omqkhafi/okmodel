# OKModel — Execution plan

Companion to `okmodel-api-design.md` (draft 22). The spec is normative; this file fixes the order of work.

## How we work

1. Claude writes one prompt (one branch). Ali gives it to Cursor.
2. Cursor implements and ends with the **execution report** (template below).
3. Ali sends the report to Claude. Claude checks it against the spec and the prompt.
   - Problem or deviation: Claude writes a **correction prompt** (same branch). Repeat.
   - Clean: Claude writes the **next prompt**.
4. Every branch ends green: typecheck, tests, repository checks. Nothing is merged red.
5. Gates (marked GATE) are reviews of evidence, not of code: measurements and findings, each classified as correctness bug, specification contradiction, measurable DX problem, measurable performance problem, or genuinely missing capability. No new API surface for imagined edge cases.
6. The spec changes only through a recorded decision (D-number). If implementation contradicts the spec, the report says so and Claude decides: fix the code or amend the spec.
7. Guarantees grow with the code. Every prompt that adds behavior also adds its tests: conformance tests for semantics, a registration in the final safety verifier for anything that adds or changes a rule, and the CI test named in the spec for any invariant it touches. A prompt is not done while a guarantee it introduces has no test.
8. Order rule: a prompt may use only what earlier prompts delivered. Where a later prompt completes a behavior, the earlier prompt ships the conservative version (stated in its row) so every branch is safe on its own.
9. Hygiene (D115): P09A is a cleanup round after the M0 gate; every later gate (P17, P30, P44, P55, P66) ends with a lighter hygiene step (dead code, duplicated helpers, flaky tests, doc sync, dependency audit, budgets re-checked) before `bun run bump release`.
10. Engineering standards (D129): every prompt optimises for performance, speed, lightness and cold start, avoids duplicated code, keeps the public API small and clear, and ends with a self-review against these rules; the report states runtime entry size, cold import and type-cost change.
11. Changelog and version: every prompt adds its notes under `## Unreleased` in `changelog.md` (what changed for someone using or building the package, one line each) and ends with `bun run bump next`, so `package.json` moves with every merged prompt. A gate prompt that releases ends with `bun run bump release` instead (D113). The pull request fails CI if either is missing.

### Execution report template (end of every prompt)

- Branch and commits
- What was built (bullets, mapped to spec sections)
- Commands run and results (typecheck, test, checks)
- Deviations from the prompt or spec, each with the reason
- Decisions Cursor made on its own, each with the reason
- Problems found, classified (bug, contradiction, DX, performance, missing capability)
- Measurements, if the prompt asked for any
- Not done, and why

## Order

Each step depends on the ones above it (dependency audit of draft 16: section "Dependency notes" at the end). IDs are stable from here on; prompts are written one at a time because each depends on what was really built.

### Phase 0 — Foundation

| ID | Branch | Delivers | Done when |
|---|---|---|---|
| P00 | `main` | repository bootstrap (done by hand-off): package `okmodel` at the repository root, workspaces under `packages/*`, git identity and commit rules, `AGENTS.md`, license, README, first commit, npm name reserved (`okmodel@0.0.0` already published) |
| P01 | `p01-foundation` | TypeScript 7 config (D111) and strictness, lint/format without the compiler API (Biome or oxlint), tooling, CI, repository checks, layer folders and entrypoints, contribution files (on top of P00) | CI green end to end on a trivial package (typecheck, test, build, publint, attw, size, core-purity and layer checks) |
| P02 | `p02-test-harness` | Postgres test harness (PGlite and a real Postgres via Docker), a Docker Compose topology with a primary and two streaming replicas (replay pausable) for CI and local runs, fixture generator for 10/50/200/500 tables, type tests (`*.test-d.ts` with `expect-type`) in the main typecheck and a type-cost measurement script from compiler diagnostics (D114), benchmark skeleton | fixtures generated deterministically; a deliberately wrong type assertion fails `bun run check` and the cost script measures a trivial type; both databases reachable from tests; the replicated topology starts and replicates in CI |

### Phase 1 — M0: validate the architecture (GATE at the end)

Spike code lives in the private workspace package `packages/spikes`; what proves useful is promoted later.

| ID | Branch | Validates |
|---|---|---|
| P03 | `p03-spike-catalog` | one object contract for table, column, index, constraint, sequence, extension, view, materialized view, function, trigger, policy, domain and a partitioned table; namespace templates; overload identity; dependency graph and ordering; deterministic hashes; scratch-database round trip; 63-character identifiers |
| P04 | `p04-spike-types` | inferred vs emitted row types on all fixtures; `Register` across files; generics suite; extension type inference; hover and error snapshots |
| P05 | `p05-spike-safety` | tagged operators cost; runtime identifier validation; final safety verification property tests over presets, traits and filters |
| P06 | `p06-spike-drivers` | capability registry linked to conformance tests on postgres.js and PGlite; cancellation; the `prepared` flag; atomic `batch` conformance including a batch-mode harness adapter over a real database, `outcome_unknown` on a killed connection, batch inside `tx()` on a savepoint; compatibility table generated from results |
| P07 | `p07-spike-migrations` | random catalog pairs A→B applied on real Postgres introspect to B; normalisation and scratch-database round trip for rewritten expressions; dependency-aware recreate; lock information |
| P08 | `p08-spike-infra` | roles and grants, extension introspection on containers, archivable feasibility with migrations |
| P08A | `p08a-spike-topology` | on real streaming replication (primary and two replicas in containers): automatic routing and the primary-required property test, `.primary()` / `.replica()` strictness, internal read-only transactions on a replica, health filtering, selection strategies, lag eligibility, fallback, per-endpoint pools, transaction affinity, pool exhaustion, and the commit-position mechanism itself (`pg_current_wal_insert_lsn()` after commit versus the commit LSN, replay paused, monotonic replay cache, capability unavailable, cost and extra fallback rate) |
| P08B | `p08b-spike-targets` | Target ≠ connection (resolver, database-per-tenant, registry, credential rotation, pool cap over 200 tenants, plans without connection details), target runner over 3 schemas and 3 databases with rollout control (`--canary`, `--class`, concurrency defaults, `--max-failures`, contract gating, second pass), migration failure and resume (transactional and non-transactional steps, per-target lock), snapshot provisioning equal to a fully migrated target with measured time, preview and rehearsal (snapshot preview, clone rehearsal, aliasing guard), `reference` rows, protected-target policy over every operation class |
| P09 | `p09-m0-gate` | consolidated findings report; decisions: catalog contract frozen, row-type default, cold start and size budgets, commit-position mechanism confirmed or amended. Claude amends the spec if needed (draft 18) |
| P09A | `p09a-cleanup` | hygiene after the M0 gate (D115). Sync `docs/` with spec draft 18, decisions D1–D127 and this plan. Add a "Resolved by" column to `docs/m0-findings.md` (mapping in decisions appendix). Tag `m0-spikes`, then promote the spike code that production needs and delete or archive the rest (findings stay as docs). Dedupe helpers, results locks and scripts; harden flaky timeouts; one Docker-skip rule; refresh `AGENTS.md` and the `okm-ship` skill; changelog tidy; dependency audit. Add the first type ceilings and size budgets (D127) and the bundle-purity CI check (no npm package inside runtime bundles; the router must not import the harness barrel); pure-TypeScript SHA-256 replaces `Bun.CryptoHasher` in core. No new behavior |

### Phase 2 — Train 0.1 Skeleton

| ID | Branch | Delivers |
|---|---|---|
| P10 | `p10-catalog-core` | production catalog: kinds for table, column, index, constraint, sequence; identity with namespaces; ownership (`managed` / `external`) in the contract for every kind; canonical form; hash |
| P10A | `p10a-standards` | engineering standards (D129) into `AGENTS.md` and the ship skill; audit of P10 for size, duplication and DX; trim what the runtime entry reaches (tooling-only code stays out). No new behavior |
| P11 | `p11-column-types` | `okmodel/pg` column types, codecs, picklists |
| P12 | `p12-tables-schema` | `table()`, `schema()`, `Register`, row types (per the gate), guards OKM1020–1023 |
| P13 | `p13-drivers` | public `Driver` contract first (`open` → `DriverPool` with `execute`, atomic `batch`, `reserve`, `stats`, `close`; `DriverError`; flags; spec 4.2), then capability registry, postgres.js and PGlite adapters (one pool per endpoint, `timeouts.acquire` with OKM1846), conformance suite v1 (execute, codecs, batch contract, reservation; error-mapping tests arrive with P14) |
| P14 | `p14-errors` | `OkmError`, database error mapping from `DriverError`, categories, `outcome_unknown`, `toHttp`, `match`, `safe`, `fix`, nearest-name hints, error registry; error-mapping conformance |
| P15 | `p15-query-core` | read path: logical query, physical plan, Postgres SQL for `find`, `one`, `count`, `exists` (where with tagged operators, select, orderBy, limit, includes as `LATERAL`), fingerprints, `inspect()` and `sql()`, `.safe()`; the L3 runtime: `connect()` with a single endpoint and the Target / Topology / Endpoint / Pool / Router shape, so routing is a decision from the first release (invariants B, C, K) and `inspect()` shows it; typed client from the schema (type-cost benchmark queries gated); OKM1111; named-statement evaluation |
| P15B | `p15b-write-path` | `insert`, `update`, `delete` (with returning, per-row lists, `expect`), chunked inserts, conflict modes as far as the spec fixes them, an internal transaction runner (reserved connection, begin, commit, savepoint) used by chunked inserts and other multi-statement writes; the write-side guards that need no policy layer |
| P16 | `p16-migrations-plan` | planning side: first the insert-completions fix (D139), then introspection of Postgres into a catalog, snapshots, dialect normalisation and scratch-database comparison (checks and index predicates normalised through the database; partition PKs and inherited indexes dropped while introspecting), diff catalog A to B with dependency-aware ordering, plan with step classification (`expand`, `contract`, unclassified), declared renames (OKM1530), D131 `--replace` with OKM1541, `okm generate` (SQL only), `okm build` (validate, emit `.okm/` with the serialised catalog, emitted row types and the table-name union), fast catalog loader and lazy catalog hash (not inside `schema()`), `okm check` (stale renames, unlisted tables), `okm migrate plan`; no tooling code reachable from the runtime entry |
| P16A | `p16a-enum-type` | enum as a catalog object (kind `type`, D140): contract, canonical form, hash, column dependency, introspection, `CREATE TYPE`, `ADD VALUE` as a marked non-transactional step, D131 recreate for removal; remove `.okm/declarations.json` as a side channel; `schema().catalog` and `okm build` work on enum columns; type cost of the real `okm build` output and editor check on emitted types |
| P16B | `p16b-migrations-apply` | applying side: `okm migrate apply`, history and `okm_meta` with the catalog hash, atomic-per-migration apply with split non-transactional steps, checkpoints and resume, per-target advisory lock (OKM1522), `lock_timeout` / `statement_timeout` with retry, pooler URL refusal, forward-only, D131 data steps applied as plain statements (batched and resumable in P52), named `targets` with required `--target` (OKM1853) and the aliasing guard (OKM1852), protected-target policy (`assertTargetPolicy`, spec 19.7), `okm migrate status`, `okm push`, `okm dev` with PGlite, the `connect()` startup check (OKM1520) with the hash fast path |
| P17 | `p17-hygiene-0.1` | hygiene round (D115): sync `docs/`, dedupe, audit size and duplication; profile app cold import by module and trim the largest items, look again at `OkmError` size, gate adapter entries on incremental bytes over the runtime entry; set the 0.1 app budget at the measured size and decide the `okmodel/pg` barrel gate versus a per-export tree-shake test (D141, D142); review every public subpath name and list the public API surface before the freeze (including `okmodel/migrate`); every not-yet-supported builder (`t.domain`) fails with a clear error naming the version; remove the name-based `push` refusal so only a `protected` target refuses it (D142, spec §19.8); decide strict mode for a missing `okm_meta`; wire `toHttp(statuses?)` into `connect()` |
| P17B | `p17b-release-0.1` | API classification of every export (stable, experimental, internal), `okmodel/internal` for internals only if no bundle grows, an API snapshot test per subpath, the per-export tree-shake test (confirm or add), `okmodel/testing` out of the exports map, corrected reserved-option versions (D143); quickstart tested in CI from the packed tarball (fresh project: schema, build, migrate on PGlite, queries), docs check, a known-limits page, a production checklist (`protected: true`, `requireMeta: true`), measured size and cold-start numbers in the docs, conformance run with the generated compatibility table, environment, preview and rehearsal recipes (spec 19.8; in 0.1 they replay history because installing the head snapshot arrives with provisioning in P53A, and the docs say so), release checklist and a publish dry run; Ali publishes 0.1.0 |
| P17C | `p17c-api-hygiene` | move the remaining internal exports off `okmodel/pg` (10) and `okmodel/migrate` (28) so a public subpath carries only public API (D144); `okmodel/migrate` keeps `defineConfig` and its types; the quickstart test runs the docs' commands verbatim, including `okm migrate apply`; README and known-limits say `okmodel/internal` has no stability promise; runtime-entry size gate to measured +10%; update the API snapshot; then 0.1.0 is ready for Ali to tag |
| P17D | `p17d-readme-0.1.1` | self-contained npm README (install, runnable quickstart, commands, known limits, measured size, absolute doc links), CI check against relative README links, README code run by the docs-as-tests test, package metadata, release workflow accepting `v<package.json version>`, version 0.1.1 prepared for Ali to tag (D147) |
| P17E | `p17e-keys-release-checks` | D148 keys (`.primaryKey()`, composite primary key, `t.id()` default choice, caller-supplied id) and release workflow checks: verify the version on npm with provenance after publish, GitHub Release from the changelog section, actions pinned by SHA, `concurrency`; README quickstart moves back to `t.id()` |

### Phase 3 — Train 0.2 Safety

| ID | Branch | Delivers |
|---|---|---|
| P20 | `p20-tagged-operators` | the 0.2 operator set of spec §10.1 (draft 24): `contains`, `containedBy`, `overlaps`, `hasKey`, `hasAnyKey`, `path`, `matches` for json, array, range and tsvector columns, OKM1124 for an operator that does not fit its column; atomic write operators `json.set`, `arr.append`, `arr.remove` as tree-shakable namespace exports; identifier-validation and operator property tests (nothing forged from JSON, nothing request-controlled reaches SQL text); the quickstart test also runs in the `postgres` job (extension operators moved to P40) |
| P21 | `p21-final-safety` | provenance with source locations and the final safety verification framework: rules register into it; P22–P28 each register theirs and extend `safety.property`, and P30 runs the full composition |
| P22 | `p22-field-exposure` | guarded, hidden, sensitive, input stripping |
| P23 | `p23-traits` | trait framework, `timestamps`, schema default traits |
| P24 | `p24-tenancy-column` | column tenancy, context client, `global`, composite foreign keys, tenant uniques |
| P25 | `p25-archivable` | archivable (column strategy), archive contract, cascade, `archiveId`, restore |
| P26 | `p26-validation` | inline and options validation, Standard Schema, branded skip |
| P27 | `p27-relations-includes` | what P15 did not ship: `manyThrough`, `.required()`, `page` (cursor), `aggregate`, nested relation-filter edge cases (basic relations, includes and `has` / `none` / `every` are in P15) |
| P28 | `p28-presets` | presets, reserved names, OKM1040 |
| P29 | `p29-transactions` | public `tx` on a reserved connection (affinity; the interactive reserved-connection runner is built here, because P15B's internal runner is batch-based, D139), public atomic `batch` per the contract, nested savepoints, retry (never on `outcome_unknown`), row locks, advisory locks, cancellation, timeouts, snapshot reads |
| P30 | `p30-gate-0.2` | isolation, safety, statement-count and archive correctness property tests; release 0.2 |

### Phase 4 — Train 0.3 Objects

| ID | Branch | Delivers |
|---|---|---|
| P40 | `p40-extensions` | `extension()` contract, lifecycle through migrations, `citext`, `pg_trgm`, `okm ext`, domains as a `type` subkind (D141) |
| P41 | `p41-functions-triggers` | `fn`, `trigger`, dependency ordering, `timestamps` with trigger enforcement |
| P42 | `p42-views` | views and materialized views, tenancy on views, dependency-aware drop and recreate around column changes (OKM1821, never `CASCADE`) |
| P43 | `p43-roles-grants` | `roles`, grants, default privileges |
| P44 | `p44-gate-0.3` | object round-trip tests; release 0.3 |

### Phase 5 — Train 0.4 Migration depth

| ID | Branch | Delivers |
|---|---|---|
| P50 | `p50-classification-linter` | expand/contract classification, linter core, safe rewrites |
| P51 | `p51-locks-recreate-verify` | lock display with row estimates; recreate verified across every object kind |
| P52 | `p52-backfill-runner` | `backfill()`, `TargetRunner` (one target) |
| P53 | `p53-drift-verify` | catalog hash fast path, previous-catalog check, migration verification, serialised catalog |
| P53A | `p53a-provisioning` | provisioning from the current snapshot, `reference` data, snapshot ↔ replayed-history equivalence in `okm migrate check` (OKM1521), OKM1542, OKM1851 |
| P54 | `p54-testing-package` | factories, `expectQueries`, isolation check, seeds |
| P55 | `p55-gate-0.4` | the full `protected.policy` enumeration (every operation class through the CLI, engine, `backfill()`, `okm seed`, runner and `provision`); release 0.4 |

### Phase 6 — Train 0.5 Topology

| ID | Branch | Delivers |
|---|---|---|
| P60 | `p60-topology-runtime` | `connect({ primary, replicas })`, topology and endpoint construction, per-endpoint pools, health and position probes, `ReplicaState` seam |
| P61 | `p61-read-routing` | automatic read routing, `.primary()`, `.replica()`, fallback policy, OKM1840/1843/1844, routing in `inspect()`. Conservative until P63: a session that has written reads from the primary (the position-unknown path) and the first healthy replica is picked |
| P62 | `p62-selection` | candidate filtering (health, consistency and lag, capacity) and the four strategies plus custom `select` |
| P63 | `p63-consistency-position` | commit position after commit, session and root watermarks, position-unknown handling, capability gate, `maxLag` |
| P64 | `p64-topology-conformance` | streaming-replication CI containers, topology conformance and property tests (`routing.*`, `pool.separation`, `tx.affinity`, `consistency.position`) |
| P65 | `p65-reference-app` | the small reference app (private workspace package `packages/reference-app`) promised by M1: multi-tenant, traits, archive, migrations, objects, and a replica topology; runs in CI as the end-to-end proof, including a preview workflow (a database per job, `migrate apply` from the snapshot) and a rehearsal against a populated clone |
| P66 | `p66-gate-m1` | release 0.5; M1 complete; OKE `store.sql` prototype starts |

### Later phases (prompts written when reached)

M2 Depth (tenancy `path`/`composite`/`rls`, `filters()`, SQL builder lane, typed raw SQL, full linter, `okm pull`, `versioned`/`sortable`, extension packs, several catalogs, dev inspector, `explain()`, `okmodel/otel`, GitHub Action, adapters), M3 SQLite, M4 MySQL, M5 Hardening (schema-per-tenant and database-per-tenant with `tenancy.registry`, target resolution, tenant provisioning and rollout control (`--class`, `--canary`, `--concurrency`, `--max-failures`, contract gating, second pass), studio, live docs), then the 1.0 gate.

## Dependency notes (audit of draft 16)

Problems found in the earlier order and how the table above resolves them:

- **Replica infrastructure:** P08A needs a replicated Postgres; P02 now builds the compose topology.
- **Errors before queries:** `OkmError` and error mapping are needed by the query core (guards, mapped failures), so P14 is errors and P15 is the query core. Conformance v1 in P13 excludes error mapping until P14.
- **Transactions before P29:** chunked inserts, `sync` and archive cascades need an atomic multi-statement write long before the public `tx`; P15 ships an internal runner and P29 exposes the public API.
- **`connect()` had no owner:** P15 builds the L3 runtime with the single-endpoint Router, Endpoint and Pool.
- **Final safety verifier before its rules exist:** P21 builds the framework; each later prompt registers its rules (process rule 7); P30 tests the composition.
- **Classification needed by the protected policy:** P16 classifies steps by operation kind; P50 adds linting and P53 the previous-catalog check.
- **Ownership needed by every object kind:** it is in the P10 contract.
- **Recreate needed by views:** dependency-aware recreate moved from P51 to P42; P51 keeps lock display and cross-kind verification.
- **`protected.policy` enumeration needs seed:** `okm seed` arrives in P54, so the full enumeration test sits in P55.
- **Routing before consistency:** P61 ships the conservative behavior (writers read from the primary) until P63 adds commit positions.
- **The M1 reference app had no prompt:** P65.
- **Named targets and apply semantics are foundations, not M5 features:** environments and previews need `--target`, resume and the per-target lock from the first release, so they are in P16; only the multi-target rollout flags wait for M5.

## Repository conventions (fixed at bootstrap)

- The published package (`okmodel`, see D110) lives at the repository root (`src/`, `package.json`, `dist/` ignored). Every other package lives under `packages/*` as a Bun workspace: private ones (`packages/spikes`, `packages/reference-app`, `packages/bench`) and later published ones (for example a studio or an MCP server). Their dependencies never enter the root `package.json`.
- The tarball is controlled by a `files` whitelist (`dist`, `README.md`, `LICENSE`); repository tooling (`tools/`, `docs/`, `packages/`) is never published.
- The repository belongs to `github.com/omqkhafi`; copyright is `Copyright 2026 Omq Khafi`; Apache-2.0.
- Every commit carries exactly two trailers: `Signed-off-by: Omq Khafi <omqkhafi@gmail.com>` (DCO) and `Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>`. No other trailer (no tool or assistant attribution) and no other personal address in any file or commit beyond these two.
- Versioning (D113): versions are `<next release>-next.N` while a train is in progress (`0.1.0-next.1`, `0.1.0-next.2`, ...). The gate prompt of a train releases it: P17 is 0.1.0, P30 is 0.2.0, P44 is 0.3.0, P55 is 0.4.0, P66 is 0.5.0. Only released versions are published to npm and tagged (`v0.1.0`); `-next` versions stay in the repository.
- No commit, pull request description, comment or file may mention the tool that produced it (no `Co-authored-by` for a tool, no "Made with" lines).
- `AGENTS.md` is the single source of agent rules; `CLAUDE.md` imports it.

## M0 follow-ups placed in prompts (from `docs/m0-findings.md`)

- P41 (function and trigger recreate): drop triggers before functions even when `DROP TABLE` removes them (found by the P07 property test).
- P12/P13: emitted types as default (D120) with a manual editor hover check; `schema()` build versus `.okm/catalog.json` load measured; evaluate `COMMIT; SELECT pg_current_wal_insert_lsn()` as one message (P13/P63).
- P25/P40: OKM1122, OKM1123 and OKM1190 `violations` (D126); `eq()` and additive-only presets (D125).
- P43: extension planning rules (D118), including `path-unverified` and the non-relocatable refusal.
- P50/P51: role and grant rules (D119); OKM1852 under D122.
- P29/P63/P64: driver contract clarifications (D124); commit-position fallback rate under write load (P64).
- P16/P60: contract gating over the whole registry (D123).
- P16: normalise check expressions and index predicates through the database (stored as text in P10, D128); declared renames must update references inside that text; drop copied partition primary keys and inherited indexes while introspecting (M0-06, D116).
- Every train: report the runtime entry size; P10 measured 29.6 KB minified / 8.9 KB gzip / 5.8 ms cold import against the 0.1 budget of 60 KB / 20 KB / 15 ms, so P11–P16 must stay within the remaining half; trim before P17 if tooling code is reachable from the runtime entry.
- P10A moved catalog document IO (serialise, parse, hash, rename, dependency order) off the runtime entry (29.6 KB to 16.5 KB). The runtime still needs the catalog hash check and `.okm/catalog.json` load at `connect()` (spec 19.3): P15 imports only the lean pieces it needs from a subpath, and loads them lazily.
- Every prompt ends with: commit, push the branch and open the pull request (Cursor stopped doing this after P10A; the prompts now say it explicitly).
- Published bundles must share modules (code splitting): the catalog identity must exist once per process (D112), so `okmodel` and `okmodel/pg` may not each inline the catalog helpers.
- P16 (generate/diff): picklist and enum value removal per D131 (`--replace`, OKM1541 with the flag in `fix`, expand/contract `backfill()` steps, final sweep, constraint swap with lock timeout and retry); enum type recreate in contract; tests for chains, many-to-one, null replacement and rows inserted during the window.
- P12 measurement rule: consumer type cost is measured against the built declarations (`.d.ts`, `skipLibCheck`), because a consumer project never type-checks the library's function bodies; the source-based number is reported but not gated.
- P12 finding: loading the serialised catalog (11.1 ms) was slower than building it with `schema()` (8.8 ms) on the 200-table fixture, so the `.okm/catalog.json` cold-start path has no benefit yet; decide at P17 whether to make the loader cheaper (trust the hash, skip re-validation, lazy objects) or soften spec 19.3.
- P16: `okm build` wires emitted types, including the table-name union for `references` (D132).
- P16: fast catalog loader that trusts the build artifact (D133); `okm check` and dev keep full validation.
- P13–P16: watch the 0.1 runtime budget (60 KB min): core plus schema is already 38 KB (D133).
- P15: OKM1111 (driver lacks a capability, runtime) with its first consumer; evaluate a named-statement option for the postgres.js adapter (D135) with a benchmark against unnamed; keep the pooler-safe default.
- P15 split: P15 is the read path and `connect()`, P15B the write path and the internal transaction runner (the original P15 row was too large for one reviewable prompt).
- P17 hygiene: gate adapter entries on incremental bytes over the runtime entry (shared code is double-counted in standalone bundles); look again at the size of `OkmError` (6.4 KB min).
- P29: real two-session serialization and deadlock races and a live connection kill during commit (P14 simulated them with ERRCODE and a unit test).
- P15 stopped at the size gate (app fixture 87,179 / 27,620 vs 60,000 / 20,000). D137: optimisation pass first (lazy error mapping and include planner, per-operator tree-shaking, no batch or routing code on the read path, one decode path), then gates at measured +3% under a hard cap of 75,000 / 24,000; P15B adds at most 12,000 / 3,800; P17 finalises the 0.1 app budget.
- P15B: automate `docs/editor-check.md` as a language-server (tsserver) snapshot check over the P15 and P15B query surface; no manual run.
- P15 merged with D137/D138: app fixture gate measures the startup graph (74,688 / 24,000), total graph reported; P15B ceiling +12,000 / 3,800.
- P15B and P17: report first-include latency and the total (lazy) graph size; docs must warn that `prepared: "named"` is not for transaction-mode poolers.
- P16: evaluate computing the catalog hash and serialisation lazily (not inside `schema()`), because app cold import on CI is 20 to 34 ms; same prompt as the fast catalog loader.
- P15B merged (D139): write path on the driver batch; editor check automated with a dev-only TS 6 package; type-cost write probe 6,451 / 6,500 types, so P16 onward reports any measurement within 3% of a ceiling.
- P16 and P16B replace the old single P16 (too large); P17 follows P16B.
- P16 merged (D140): `defineConfig` from `okmodel/migrate`; composite probe types ceiling 7,100; enum becomes a catalog object in P16A before P16B; `loadTrustedCatalog` is wired into `connect()` in P16B.
- P17: profile app cold import by module (local 10.1 ms vs 2.1 ms runtime entry, CI 25.2 ms) and fix the largest item; review all public subpath names (including `okmodel/migrate`) before the freeze.
- P16A merged (D141): enum is a catalog object; domains wait for P40 and raise a clear error until then (P17 lists every unsupported builder in the docs).
- P16B: must not grow `okmodel/pg` (151 bytes left); app startup gate re-set only inside the D138 cap. P17: decide barrel gate versus per-export tree-shake test.
- P16B merged (D142): apply, `okm_meta`, targets, policy, status, push, dev and the startup check; P17 split into P17 and P17B; app startup budget is per release.
- P17 merged (D143): 0.1 budgets set; barrel gate replaced by a per-export tree-shake test; `requireMeta`; subpaths frozen; API classification and snapshot test in P17B; the 0.2 start point for P30 is 91,000 / 30,000.
- P17B merged (D144): API classified, snapshot test, `okmodel/internal`, runtime entry 5,525 / 2,042; P17C removes the leftover internal exports from public subpaths before the tag.
- P17C merged (D145): public subpaths carry only public API; Ali tags 0.1.0; the 0.2 train starts with P20 (operator set defined in spec draft 24).
- 0.1.0 published (D146): releases publish with `npm publish` through the npm trusted publisher; P20 verifies `bun run bump next` after the tag and merges `main` first (the workflow fix went to `main` directly).
- P17D (D147): the 0.1.0 npm page has no usage information; a self-contained README ships as 0.1.1 before the 0.2 train work merges.
