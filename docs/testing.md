# Testing

`okmodel/testing` opens a real database and returns factories, a query counter, and a cross-tenant isolation check. The pool comes from `open()`. There is no mock database.

```ts
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

`open()` is async and returns a driver pool. `open({ url })` from `okmodel/pg/postgresjs` is synchronous and is accepted the same way. `testing` applies the schema's catalog first, which is what an empty PGlite database needs. Pass `migrate: false` when the database already has its tables. `okm seed` does that.

`tenants` in the example is a global table (`global("tenant directory")`). Its `id` is the value passed to `for({ tenantId })`. `users` and `tasks` are tenant tables. `lists` is the table `x.ref("lists")` inserts or reuses. `loadToday` is the application's read; the count is how many statements that read sends.

## Factories

`t.factories({ table: (x) => ({ ... }) })` returns `create`, `createMany(n)`, and `with({ child: n })` for each table. `with` inserts the parent, then that many children, and sets the child's foreign key from a `many` relation, a `one` relation, or the catalog foreign key. `x.ref("table")` inserts the referenced row the first time and reuses it for later rows in the same tenant.

Generators are `x.email()`, `x.name()`, `x.words(n)`, `x.int()`, `x.float()`, `x.boolean()`, `x.date()`, `x.uuid()`, and `x.pick(list)`. They are implemented in this package. Pass `seed` to `testing` to replay them. The default seed is `1`. The same seed and the same calls produce the same values.

A required column the factory leaves out is filled from its type: text, uuid, integers, numeric, boolean, JSON, enums, and `Temporal` values the column accepts. A nullable column, a database default, an identity, a generated column, a client `fill`, and a guarded column are left alone. The tenant key is guarded. Pass it as `create({ tenantId })` or it is generated. `create` returns the inserted row as a record.

## expectQueries

`expectQueries(n, fn)` fails when `fn` sends a different number of statements. The error lists the statements that were counted. Transaction control is not counted: `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ROLLBACK TO`, `SAVEPOINT`, `RELEASE`, `SET TRANSACTION`, `SET LOCAL`, and `SET SESSION CHARACTERISTICS`. A data statement inside `tx` is counted.

## Isolation

`isolation()` inserts one row as tenant B on every tenant table and reads and writes it as tenant A: `find`, `one`, `count`, `exists`, `include` when the table has a relation, `update`, and `delete`. A returned row, or an update or delete that touches a row, fails with the table, the query, and the row. Global tables are skipped and named, with the reason from `global("reason")`. Column tenancy is the strategy this version checks. Schema-per-tenant and database-per-tenant are M5.

## okm seed

```ts
export default async function seed(t) {
  const f = t.factories({
    notes: (x) => ({ title: x.words(2) }),
  });
  await f.notes.create();
}
```

`okm seed <file>` loads that default export and calls it with the harness for the selected target. The target's schema must already be applied. One configured target is used as it stands. Several targets require `--target` (OKM1853). A protected target is blocked (OKM1850) unless the invocation passes `--allow-protected`. The command prints `target <name>` and one line per table that the factories inserted, or `created nothing`.
