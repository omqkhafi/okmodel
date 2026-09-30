# OKModel — Gap research (2026-09-26)

Status: research notes supporting the gap review of API draft 3. Each section lists what was found, the evidence, and the resulting recommendation. Nothing here is approved until folded into `okmodel-api-design.md`.

## Summary

The research confirms 12 of the 15 gaps and adds four new findings. The three most consequential:

1. **Operator injection ("ORM Leak")** is a documented, practical attack against object-style `where` APIs like ours. It changes how operators must be represented.
2. **Soft delete** is widely criticised by experienced Postgres engineers; OKModel should offer an archive strategy alongside the `deleted_at` column.
3. **Precomputed types beat inferred types** in the only public, instrumented comparison (Prisma vs Drizzle with `@ark/attest`). The row-type strategy must be decided by measurement, and `attest` gives the tool for the CI budget.

## 1. Tenant-scoped uniqueness and composite foreign keys

**Finding.** Multi-tenant guidance is consistent: unique constraints should be per tenant, indexes should lead with the tenant key, and foreign keys should include the tenant key so a child cannot reference another tenant's parent.

**Evidence.**
- A Postgres multi-tenant best-practices guide recommends `UNIQUE (tenant_id, …)` instead of global uniqueness because emails and slugs "collide across tenants by design", composite FKs that include `tenant_id`, and indexes with `tenant_id` leading ([codeguides](https://postgresql.codeguides.io/multi-tenant-patterns/best-practices/)).
- Ecto's official guide implements exactly this: a unique index on `(id, org_id)` and `references(:posts, with: [org_id: :org_id])`, so a comment's org must match its post's org at the database level ([Ecto](https://ecto.hexdocs.pm/multi-tenancy-with-foreign-keys.html)).

**Recommendation.** Confirmed as designed in the gap review:
- `.unique()` on a tenant table becomes `UNIQUE (tenant_key, …)`; opt-out `.unique({ global: "reason" })`.
- Every tenant table gets `UNIQUE (id, tenant_key)`; FKs between tenant tables become composite.
- Lint (OKM1706): an index on a tenant table that does not lead with the tenant key.

## 2. Soft delete

**Finding.** Two separate problems.

**2a. Unique constraints.** Soft-deleted rows keep occupying unique values, so a user who deletes an account cannot re-register with the same email. The standard fix in Postgres is a partial unique index `WHERE deleted_at IS NULL`; MySQL has no partial indexes and uses a generated column that is `NULL` for deleted rows ([PHP Architect](https://www.phparch.com/2026/02/advanced-unique-index-patterns-for-soft-deletes-mysql-and-postgresql/); [ZenStack](https://zenstack.dev/blog/soft-delete-real)).

**2b. The pattern itself.** Brandur Leach (formerly Stripe, Heroku) argues soft deletion is rarely worth it: every query must remember `deleted_at IS NULL`, foreign keys stop protecting integrity (a soft-deleted parent leaves live children), GDPR-style hard deletion later becomes elaborate, and in ten years he never saw an undelete actually used. His alternative is a single `deleted_record` table holding the deleted row as `jsonb`, which keeps foreign keys meaningful and makes retention a one-line delete ([brandur.org](https://brandur.org/soft-deletion)).

**Recommendation.**
- Offer two traits with honest names, and make the choice explicit:
  - `softDelete()` — the `deletedAt` column. Unique constraints become partial automatically (pg) or use the generated-column technique (MySQL); the default scope applies to includes as well; `cascade: [...]` declares which children are soft-deleted with the parent.
  - `archiveOnDelete()` — `delete()` moves the row (and declared children) into a shared `deleted_records` table in the same statement (`DELETE … RETURNING` into the archive). Foreign keys and unique constraints stay untouched; `restore()` re-inserts from the archive; retention is `purgeArchive({ olderThan })`.
- Docs recommend `archiveOnDelete()` by default and `softDelete()` only when the app has a visible "trash" that users restore from.

## 3. Mass assignment and excessive data exposure

**Finding.** OWASP API Security Top 10 (2023) merges both into API3, Broken Object Property Level Authorization. The recommended controls: never bind client input directly to object properties, restrict updatable fields to those clients legitimately need, and never return objects through generic serialisation — select properties explicitly ([OWASP API3:2023](https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/)).

**Recommendation.**
- **Input side:** unknown keys are always stripped. `.guarded()` fields are never filled from input; the tenant key, primary key, trait fields (`createdAt`, `updatedAt`, `deletedAt`, `version`) are guarded automatically. Per-call exceptions: `{ allow: ["role"] }`.
- **Output side (new):** `.hidden()` fields (for example `passwordHash`, `resetToken`) are excluded from default selects and from `include`; they are returned only when named in `select` explicitly. This closes the "excessive data exposure" half of API3.

## 4. Injection through identifiers and operators

**4a. Identifiers.** Sequelize has a history of SQL injection CVEs (for example CVE-2019-10752 and CVE-2023-25813), and an analysis of its `quoteIdentifiers` option shows user-controlled column names in `attributes` and `order` becoming executable SQL; the recommended mitigation is allowlisting column names against the model ([OSec](https://www.osec.com/insights/optional-sql-injection); [GitHub advisory](https://github.com/advisories/GHSA-wrh9-cjv3-2hpw)).

**4b. Operators ("ORM Leak") — new finding.** Research by elttam shows that when an application passes user-controlled objects into Prisma `where` filters, attackers can use operators such as `startsWith` through relations to extract secrets character by character (for example a creator's `resetToken`), loop through many-to-many relations to bypass restrictions, and even run time-based extraction without any visible output ([elttam](https://www.elttam.com/blog/plorming-your-primsa-orm)). Object-style filters like `{ email: { startsWith: "a" } }` are indistinguishable from JSON a client can send.

**Recommendation.**
- Column names in `select`, `orderBy`, `where` and `include` are validated at runtime against the catalog (OKM1120), in addition to types.
- **Operators are tagged values, not plain objects.** `where: { dueAt: lt(date), title: startsWith("a") }`. JSON cannot produce a tagged value, so a request body can never introduce an operator. A plain object where a scalar is expected is rejected at runtime (OKM1121).
- Relation filters take a tagged helper as well: `where: { list: has({ name: "Work" }) }`, so request JSON cannot traverse relations either.
- For API-driven filtering (list endpoints with user filters), a dedicated, allowlisted builder: `tasks.filters({ allow: { title: ["eq", "startsWith"], dueAt: ["lt", "gt"] } }).parse(query)`.
- `sql.raw()` requires a reason argument.

This is a real API change from draft 3 (object operators like `{ lt: date }` become `lt(date)`).

## 5. Rolling deploys, drift and expand/contract

**Finding.**
- Expand/contract is the standard way to keep old and new application versions working during a rolling deploy: expand (add, optional), backfill and switch reads, then contract (remove) ([field notes](https://dev.to/ahmed_mahmoud360/zero-downtime-postgres-migrations-field-notes-on-expandcontract-locktimeout-and-the-alter-3d3m)). pgroll automates it with versioned schema views, trigger-based dual writes, and explicit start/complete/rollback ([Xata](https://xata.io/blog/pgroll-expand-contract)).
- The same field notes list operational rules: set `lock_timeout` before DDL because an `ALTER TABLE` waiting for a lock blocks every query queued behind it; split constraints into `NOT VALID` + `VALIDATE`; build indexes `CONCURRENTLY` outside transactions; backfill in batches; run migrations as a pipeline step, never at application boot, and through a direct connection rather than a pooler.

**Recommendation.**
- Every generated migration is classified `expand` or `contract` by the planner.
- The startup check becomes a **compatibility** check: the database may be ahead of the code by expand migrations; being ahead by a contract migration, or behind, fails closed (OKM1520).
- The migration runner sets `lock_timeout` and `statement_timeout` by default and retries lock timeouts with backoff.
- `okm migrate apply` refuses to run through a known pooler URL unless told otherwise, and the docs describe it as a deploy-pipeline step.
- Expand/contract helpers (rename, type change) return to M2.

## 6. Migration safety rules

**Finding.** Three mature rule sets exist and overlap heavily:
- Squawk's 40 rules include requiring concurrent index creation and deletion, `constraint-missing-not-valid`, `adding-not-nullable-field`, `changing-column-type`, `renaming-column`, `require-lock-timeout`, `prefer-identity`, `prefer-timestamptz`, `prefer-text-field` and `ban-char-field` ([Squawk](https://squawkhq.com/docs/rules)).
- strong_migrations (Rails) lists safe alternatives: concurrent indexes, unique constraints built from a concurrent unique index, adding a column without a volatile default then setting it, `SET NOT NULL` via a validated check constraint first, `jsonb` over `json` ([strong_migrations](https://github.com/ankane/strong_migrations)).
- Atlas groups analyzers into backward-incompatible, destructive, data-dependent, constraint deletion and Postgres operational categories ([Atlas](https://atlasgo.io/lint/analyzers)).

**Recommendation.** Seed the built-in linter from these categories with stable codes in OKM1510–1549: backward-incompatible (feeds the expand/contract classifier), destructive, data-dependent, locking, and type preferences. Where a safe rewrite is mechanical (concurrent index, `NOT VALID` + `VALIDATE`, `SET NOT NULL` via check), the planner generates the safe form directly instead of only warning.

## 7. Renames

**Finding.** Drizzle-kit relies on interactive prompts to tell renames from drop-and-add, which breaks CI and AI agents; a January 2026 issue asks for `--preflight` / `--answers` flags ([#5307](https://github.com/drizzle-team/drizzle-orm/issues/5307)). Several open bugs involve renames losing other changes, such as a rename plus a length change producing only the rename ([#5499](https://github.com/drizzle-team/drizzle-orm/issues/5499); [#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826); [#6360](https://github.com/drizzle-team/drizzle-orm/issues/6360)).

**Recommendation.** Renames are declared, never guessed: `title: t.varchar(200).renamedFrom("name")` and `table("tasks", …, { renamedFrom: "todos" })`. The planner never prompts. An ambiguous diff (a drop and an add of the same type with no declaration) fails with OKM1530 and a message showing the line to add. The declaration is removed once the migration is applied (`okm check` reports stale ones).

## 8. Global `Register` and multiple schemas

**Finding.** TanStack Router's global `Register` type has a known weakness: in monorepos, tests with smaller routers, or apps with several routers, one registration claims to describe everything, and a wrong registration goes undetected; maintainers accept the monorepo limitation in exchange for less boilerplate ([TanStack discussion](https://github.com/TanStack/router/discussions/2384)).

**Recommendation.** Keep `Register` as the default for the common single-schema app, and make every public type and API accept an explicit schema:
- `Row<"events", typeof reportsSchema>`, `Client<typeof reportsSchema>`, `TableName<typeof reportsSchema>`.
- Each `connect()` returns a client typed by the schema it was given, regardless of `Register`.
- `okm check` warns when more than one `Register` augmentation exists in a project (OKM1025).

## 9. Drivers without interactive transactions

**Finding.** Neon's HTTP driver supports only non-interactive transactions (a batch of queries in one request); interactive transactions need WebSockets, and those clients must be created and closed inside a single request handler in serverless environments ([Neon](https://neon.com/docs/serverless/serverless-driver)). Cloudflare D1 has no `BEGIN`; atomicity comes from `batch()`, and read-then-write logic with application branching cannot be expressed ([D1 analysis](https://dev.to/hirodeath/cloudflare-d1-has-no-begin-transaction-so-i-tested-its-limits-and-batch-api-5813)).

**Recommendation.** A capability flag `transactions: "interactive" | "batch"`. With `"batch"`, `tx(callback)` does not exist in the types; `db.batch([q1, q2, …])` does, and it exists on every driver. Docs describe folding conditions into SQL and optimistic locking (`versioned()`) as the replacement for read-then-write.

## 10. RLS strategy footguns

**Finding.** Four recurring failures ([Patotski](https://patotski.com/blog/postgres-row-level-security-multi-tenant/)):
1. Table owners and superusers bypass RLS unless `FORCE ROW LEVEL SECURITY` is set and the app connects as a non-owner role.
2. Plain `SET` leaks tenant context across pooled connections; `SET LOCAL` inside a transaction is required.
3. Without indexes leading with the tenant key, RLS filters scan too much.
4. An unset tenant variable can error or expose rows; `current_setting(…, true)` should make it return nothing.

**Recommendation.** The `rls` strategy generates `FORCE ROW LEVEL SECURITY`, uses `set_config('app.tenant', $1, true)` inside the transaction it opens for every scoped call, writes policies with the missing-ok form, and at connect time refuses to run if the connected role owns the tables or is a superuser (OKM1707). The index lint from section 1 applies.

## 11. Picklist instead of enums

**Finding.** Crunchy Data recommends trying `CHECK` constraints before enums: they give the same restriction, allow adding and removing values easily, and can express richer rules ([Crunchy Data](https://www.crunchydata.com/blog/enums-vs-check-constraints-in-postgres)). strong_migrations notes that renaming an enum value requires adding a new value, updating code and backfilling ([strong_migrations](https://github.com/ankane/strong_migrations)).

**Recommendation.** Confirms `.picklist([...])` compiled to a `CHECK` constraint. Changing the list generates `ADD CONSTRAINT … NOT VALID` + `VALIDATE` (section 6), and removing a value is flagged as data-dependent until the data is checked.

## 12. `bigint` and JSON

**Finding.** `JSON.stringify` throws a `TypeError` on BigInt values; MDN recommends a replacer function over patching `BigInt.prototype` ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt)).

**Recommendation.** Default codec for `bigint` becomes `"string"` (consistent with `numeric`). Projects that choose `"bigint"` get `okm.json(value)` / `okm.jsonReplacer` for responses. Identity keys use `bigint` only when the schema opts in.

## 13. Type performance: inferred versus precomputed

**Finding.** The only public, instrumented comparison used `@ark/attest` to count type instantiations and measure check time on the Northwind schema. Schema definition: Prisma 428 instantiations / 205 ms; Drizzle 0.44 41,150 / 602 ms; Drizzle 1.0 beta 5,017 / 369 ms. Relational queries: Prisma averaged 785 instantiations and 335 ms; Drizzle 0.44 1,165 and 697 ms. Prisma attributes the gap to generating flat `.d.ts` once instead of re-deriving types on every keystroke, reusing interfaces, and avoiding non-homomorphic mapped types, deeply nested conditionals and large intersections ([Prisma](https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle)). The study was published by Prisma, so it is not neutral, but the method is reproducible.

**Recommendation.**
- Use `@ark/attest` in CI for the internal-goal budget: instantiation counts per benchmark query, with fixed ceilings set after the M0 spike.
- The M0 type spike compares two row-type strategies on the same 200-table fixture: (a) shallow inference from table files, (b) flat interfaces emitted by `okm dev` into `.okm/types.d.ts`. The winner becomes the default; the design already has the build step for typed SQL and migrations, so (b) adds no new tool.

## 14. Unbounded includes

No external research needed; it follows from the existing `limit` rule. To-many `include` requires `limit` or `.all("reason")` (OKM1105).

## 15. Plan-level gaps

- **Validation app.** OKTasks is built on okengine, whose Store has its own data layer, so it cannot validate OKModel unless OKE Store adopts OKModel or another reference app is chosen. Decision needed.
- **M1 scope.** Reduce M1 to a thin vertical slice (pg + postgres.js + PGlite, tables and CRUD with includes, `column` tenancy, core traits, errors, basic migrations, testing) proven by a small real app before widening.
- **Budget numbers.** Replace "linear" with concrete ceilings from the M0 attest run.

## Changes to fold into the API design

| # | Change | Type |
|---|---|---|
| 1 | Tenant-scoped `unique`, composite FKs, tenant-leading index lint | decision |
| 2 | `softDelete()` with partial uniques, scoped includes, `cascade`; new `archiveOnDelete()` recommended by default | decision |
| 3 | Unknown keys stripped; `.guarded()` (auto for keys and trait fields); `.hidden()` for output | decision |
| 4 | Runtime identifier validation; **tagged operators** (`lt(x)`, `startsWith(x)`, `has({...})`); `tasks.filters({ allow })` for API filters; `sql.raw` needs a reason | decision, API change |
| 5 | Expand/contract classification, compatibility-based drift check, `lock_timeout` by default, pipeline-only migrations | decision |
| 6 | Linter seeded from Squawk, strong_migrations and Atlas categories; safe rewrites generated automatically | decision |
| 7 | Declared renames (`renamedFrom`), no prompts | decision |
| 8 | Explicit-schema type parameters alongside `Register` | decision |
| 9 | `transactions: "interactive" \| "batch"` capability, universal `db.batch()` | decision |
| 10 | RLS strategy hardening | decision |
| 11 | `.picklist()` as CHECK, safe list changes | confirmed |
| 12 | `bigint` codec default `"string"` | decision |
| 13 | `@ark/attest` budgets; spike inferred vs emitted row types | decision |
| 14 | To-many include requires `limit` | decision |
| 15 | Validation app, thinner M1, concrete budgets | needs Ali |

## Sources

- [Postgres multi-tenant best practices (codeguides)](https://postgresql.codeguides.io/multi-tenant-patterns/best-practices/)
- [Ecto: multi-tenancy with foreign keys](https://ecto.hexdocs.pm/multi-tenancy-with-foreign-keys.html)
- [PHP Architect: unique index patterns for soft deletes](https://www.phparch.com/2026/02/advanced-unique-index-patterns-for-soft-deletes-mysql-and-postgresql/)
- [ZenStack: soft delete and unique constraints](https://zenstack.dev/blog/soft-delete-real)
- [Brandur: Soft deletion probably isn't worth it](https://brandur.org/soft-deletion)
- [OWASP API3:2023](https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/)
- [OSec: optional SQL injection in Sequelize](https://www.osec.com/insights/optional-sql-injection)
- [Sequelize advisory GHSA-wrh9-cjv3-2hpw](https://github.com/advisories/GHSA-wrh9-cjv3-2hpw)
- [elttam: plORMbing your Prisma ORM](https://www.elttam.com/blog/plorming-your-primsa-orm)
- [Zero-downtime Postgres migrations: field notes](https://dev.to/ahmed_mahmoud360/zero-downtime-postgres-migrations-field-notes-on-expandcontract-locktimeout-and-the-alter-3d3m)
- [Xata: pgroll and expand/contract](https://xata.io/blog/pgroll-expand-contract)
- [Squawk rules](https://squawkhq.com/docs/rules)
- [strong_migrations](https://github.com/ankane/strong_migrations)
- [Atlas migration analyzers](https://atlasgo.io/lint/analyzers)
- [Drizzle #5307](https://github.com/drizzle-team/drizzle-orm/issues/5307) · [#5499](https://github.com/drizzle-team/drizzle-orm/issues/5499) · [#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826) · [#6360](https://github.com/drizzle-team/drizzle-orm/issues/6360)
- [TanStack Router: global Register discussion](https://github.com/TanStack/router/discussions/2384)
- [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver)
- [D1 transactions and batch](https://dev.to/hirodeath/cloudflare-d1-has-no-begin-transaction-so-i-tested-its-limits-and-batch-api-5813)
- [Postgres RLS for multi-tenancy: footguns](https://patotski.com/blog/postgres-row-level-security-multi-tenant/)
- [Crunchy Data: enums vs check constraints](https://www.crunchydata.com/blog/enums-vs-check-constraints-in-postgres)
- [MDN: BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt)
- [Prisma: why Prisma checks types faster than Drizzle](https://www.prisma.io/blog/why-prisma-orm-checks-types-faster-than-drizzle)
