---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: [OKM1111, OKM1120, OKM1707, OKM1850, OKM1853, OKM1860]
---
# Testing

`okmodel/testing` opens a real database and returns factories, a query counter, and a cross-tenant isolation check. The pool comes from `open()`. There is no mock database.

<!-- support: tooling.testing -->
Postgres: native. Proof passes (`factories create, reuse a ref, fill defaults, and replay a seed`).
<!-- /support -->

```ts no-check="needs a running database and the application's schema"
import { testing } from "okmodel/testing";
import { open } from "okmodel/pg/pglite";

const t = await testing(appSchema, { driver: open() });
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

`open()` is async and returns a driver pool. `open({ url })` from `okmodel/pg/postgresjs` is synchronous and is accepted the same way. `testing` applies the schema's catalog first, which is what an empty PGlite database needs. Pass `migrate: false` when the database already has its tables. `okm seed` does that. `close()` drops the objects that apply created, in reverse dependency order, and drops nothing when `migrate` is false.

`tenants` in the example is a global table (`global("tenant directory")`). Its `id` is the value passed to `for({ tenantId })`. `users` and `tasks` are tenant tables. `lists` is the table `x.ref("lists")` inserts or reuses. `loadToday` is the application's read; the count is how many statements that read sends.

## Factories

`t.factories({ table: (x) => ({ ... }) })` returns `create`, `createMany(n)`, and `with({ child: n })` for each table. `with` inserts the parent, then that many children, and sets the child's foreign key from a `many` relation, a `one` relation, or the catalog foreign key. `x.ref("table")` inserts the referenced row the first time and reuses it for later rows in the same tenant.

Generators are `x.email()`, `x.name()`, `x.words(n)`, `x.int()`, `x.float()`, `x.boolean()`, `x.date()`, `x.uuid()`, and `x.pick(list)`. They are implemented in this package. Pass `seed` to `testing` to replay them. The default seed is `1`. The same seed and the same calls produce the same values.

A required column the factory leaves out is filled from its type: text, uuid, integers, numeric, boolean, JSON, enums, and `Temporal` values the column accepts. A nullable column, a database default, an identity, a generated column, a client `fill`, and a guarded column are left alone. The tenant key is guarded. Pass it as `create({ tenantId })` or it is generated. Under `compositeTenancy()`, pass every key or omit them so the helper generates a distinct uuid per key. A partial explicit key (only one of two) is refused; it is never overwritten with another key's value. `isolation()` still seeds both keys with the same uuid for its A/B pair. `x.ref` uses the single non-tenant primary-key column. Concurrent `create` calls do not share an in-flight cycle marker. `create` returns the inserted row as a record.

## expectQueries

`expectQueries(n, fn)` fails when `fn` sends a different number of statements. The error lists the statements that were counted. Transaction control is not counted: `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ROLLBACK TO`, `SAVEPOINT`, `RELEASE`, `SET TRANSACTION`, `SET LOCAL`, and `SET SESSION CHARACTERISTICS`. A data statement inside `tx` is counted.

## Isolation

`isolation()` and `testing()` cannot open `rlsTenancy` on PGlite or on a superuser harness. The first scoped call is OKM1707, because that role is the table owner or a superuser. The supported path is a non-superuser role on a real Postgres: `open({ url })` from `okmodel/pg/postgresjs`, with `migrate: false` when the tables are already there.

`isolation()` picks a new tenant A and tenant B on every call. It inserts one row as tenant B on every tenant table that has a factory, then reads and writes that row as tenant A, filtered by the key it inserted: `find`, `one`, `count`, `exists`, `include` when the table has a relation, `aggregate`, `page`, `update`, and `delete`. `batch` runs when the client has it. `stream` runs when the driver has it. A returned row, a count above zero, or an update or delete that touches a row, fails with the table, the query, and the row. It deletes what it inserted. A tenant table with no factory, when `factories()` was given other tables, fails with `Factory <table> is missing.` It then reads every tenant view and materialized view. Both tenants' rows are inserted into the underlying tables, never into the view. Under `compositeTenancy()`, every key is set on the seeded row (the isolation helper still uses one uuid for every key in its A/B scope). A materialized view is refreshed first. `testing()` with the default `migrate: true` plain-populates every materialized view after apply, so a later `refresh: "concurrently"` (in `isolation()` or `db.views.<name>.refresh()`) is not refused as "not populated". With `migrate: false`, `isolation()` falls back to one plain refresh when concurrent refresh says the view is empty; outside `isolation()`, run a plain `REFRESH MATERIALIZED VIEW` once before the first concurrent `refresh()`. After factory inserts, call `await db.views.<name>.refresh()` so the matview sees the new rows. `find`, `one`, `count`, `exists`, and `stream` use a text column from tenant B when the view exposes one, and the read is also scanned for tenant B's key. A global view is skipped and named, with the reason from `global("reason")`, in the same `skipped` list as a global table. Checked views are `report.views`. Checked tables stay `report.checked`. Column, composite, path, and `rls` tenancy are the strategies this version checks, including a `security_invoker` view and a table marked `withOwner(..., "external")` under `rlsTenancy`. Schema-per-tenant and database-per-tenant are M5.

## okm seed

```ts no-check="seed file; the harness argument is supplied by okm seed"
export default async function seed(t) {
  const f = t.factories({
    notes: (x) => ({ title: x.words(2) }),
  });
  await f.notes.create();
}
```

`okm seed <file>` loads that default export and calls it with the harness for the selected target. Under `rlsTenancy` the command runs as the application role. The owner, a superuser, or a `BYPASSRLS` role gets OKM1707. The target's schema must already be applied. One configured target is used as it stands. Several targets require `--target` (OKM1853). A protected target is blocked (OKM1850) unless the invocation passes `--allow-protected`. The command prints `target <name>` and one line per table that the factories inserted, or `created nothing`.

## Conformance

The driver, error, and transaction suites share one tag. `portable(test)` marks a case every dialect runs. `gated(test, feature, profile)` marks a case that needs a registry key or an adapter gate (`transactions`, `stream`, `listen`, `cancel`). The tag is the helper, not the case title.

A gated case runs its body when the registry says `native` or `emulated` and the adapter gate, if the entry has one, is on. A `refused` entry does not run the body. The case calls the same check the Postgres registry uses and asserts that entry's code and that the error carries the entry's alternative. A false adapter flag on an entry the registry still provides is `unsupported`. The driver report keeps one row per case (`pass`, `fail`, or `unsupported`) and ends with counts: portable run, gated run, refusal, unsupported.

`packages/harness/src/closed-profile.ts` is a test fixture. `src/` does not import it. Every Postgres registry key is `refused`, with OKM1860 and an alternative, and the adapter flags are all off (`transactions: "none"`, `stream`, `listen`, and `cancel` false). `prepared` and `describe` are not flags. Against that profile, each registry key is refused through `assertSupported`, and a schema that uses a catalog feature is refused when a new statement is planned. Replaying that schema through `planMigration` does not raise OKM1860. `tx()` with no timeout is OKM1111 and names `batch()` as the alternative. A positive `timeout` is OKM1120 because cancel is off; that error does not carry a registry alternative. `stream`, `listen`, and `describe` have no refusal: `.stream()` does not read the flag, and `listen` and `describe` are absent unless the pool defines them.

The portable minimum still passes on that profile: `connect`, a parameterised read and write through the in-memory driver, and mapping a unique violation. A new dialect ships a registry and passes that minimum before it marks a feature `native` or `emulated`. A feature it refuses needs `refusal:<key>` as a literal test title, a code, and an alternative. A feature it claims needs the `proof` title already on the entry, and the gated cases for that key then run.
