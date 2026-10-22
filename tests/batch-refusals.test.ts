/**
 * `batch` refuses what it cannot check atomically (D183), on real Postgres.
 *
 * A `restore` is blocked while its parent is archived, a write with `expect`
 * compares its count with the number it asked for, and a versioned update finds a
 * stale version. All three are judged after the statement ran. A batch cannot
 * report that after it commits, so `db.batch` refuses them with OKM1121 before any
 * statement is sent, and `tx()` still does all three. `tx.batch` takes a versioned
 * update: a stale version fails the transaction.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withGate, type GateEnv } from "./gate-env.js";
import { key, TENANT_A } from "./gate-schema.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { versioned } from "../src/runtime/traits/index.js";

const gate = await loadPostgresGate();

/**
 * The client, reached by table name with chained calls (`.expect()`, `.onlyArchived()`).
 * `any` is justified here: this test calls the runtime surface the way an application
 * does, and the point of the test is what the runtime does with calls the types allow.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type Loose = { readonly [table: string]: any };

async function refused(run: () => PromiseLike<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** An org, its project, and the org archived, so the project cannot be restored. */
async function seed(env: GateEnv): Promise<Loose> {
  const db = env.db.for({ tenantId: TENANT_A }) as unknown as Loose;
  await db.orgs.insert({ id: key("o", 0), name: "n0" });
  await db.projects.insert({ id: key("p", 0), orgId: key("o", 0), name: "n0" });
  await db.orgs.archive({ where: { id: key("o", 0) } });
  return db;
}

const names = async (env: GateEnv): Promise<string[]> =>
  (await env.rows("orgs", TENANT_A)).map((row) => String(row.name)).sort();

postgresTest(
  gate,
  "batch runs every write kind in one list and keeps the order",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const db = env.db.for({ tenantId: TENANT_A }) as unknown as Loose;
      await db.orgs.insert({ id: key("o", 0), name: "n0" });
      await db.orgs.insert({ id: key("o", 1), name: "n1" });
      await db.orgs.insert({ id: key("o", 2), name: "n2" });
      const results = await db.batch([
        db.orgs.insert({ id: key("o", 3), name: "n3" }),
        db.orgs.update({ where: { id: key("o", 0) }, set: { name: "renamed" } }),
        db.orgs.delete({ where: { id: key("o", 1) } }),
        db.orgs.archive({ where: { id: key("o", 2) } }),
      ]);
      expect(results).toHaveLength(4);
      expect(results[1]).toEqual({ count: 1 });
      expect(results[2]).toEqual({ count: 1 });
      expect(results[3].count).toBe(1);
      expect(typeof results[3].archiveId).toBe("string");
      expect(await names(env)).toEqual(["n2", "n3", "renamed"]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "batch refuses a restore with OKM1121 before any statement, and writes nothing",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const db = await seed(env);
      const before = await names(env);
      env.drain();
      const error = await refused(() =>
        db.batch([
          db.orgs.insert({ id: key("o", 1), name: "extra" }),
          // The project's org is archived, so this restore is blocked.
          db.projects.onlyArchived().restore({ where: { id: key("p", 0) } }),
        ]),
      );
      expect(error.code).toBe("OKM1121");
      expect(error.message).toContain("tx()");
      expect(error.message).toContain("restore");
      expect(env.rec.log).toEqual([]);
      // The other write of the list is absent.
      expect(await names(env)).toEqual(before);
      // A restore that would succeed is refused the same way.
      const open = await refused(() =>
        db.batch([db.orgs.onlyArchived().restore({ where: { id: key("o", 0) } })]),
      );
      expect(open.code).toBe("OKM1121");
      expect(env.rec.log).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "batch refuses a write with expect, in every form, and writes nothing",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const db = env.db.for({ tenantId: TENANT_A }) as unknown as Loose;
      await db.orgs.insert({ id: key("o", 0), name: "n0" });
      const before = await names(env);
      env.drain();
      const lists: (() => PromiseLike<unknown>)[] = [
        // The option on the call, wrong count.
        () =>
          db.batch([
            db.orgs.insert({ id: key("o", 1), name: "extra" }),
            db.orgs.update({ where: { id: key("o", 0) }, set: { name: "x" } }, { expect: 5 }),
          ]),
        // The modifier, right count: refused all the same, the check is not the count.
        () =>
          db.batch([
            db.orgs.insert({ id: key("o", 1), name: "extra" }),
            db.orgs.delete({ where: { id: key("o", 0) } }).expect(1),
          ]),
        // Archive carries it too.
        () =>
          db.batch([
            db.orgs.insert({ id: key("o", 1), name: "extra" }),
            db.orgs.archive({ where: { id: key("o", 0) } }).expect(1),
          ]),
        // And insert.
        () => db.batch([db.orgs.insert({ id: key("o", 1), name: "extra" }, { expect: 1 })]),
      ];
      for (const run of lists) {
        const error = await refused(run);
        expect(error.code).toBe("OKM1121");
        expect(error.message).toContain("expect");
        expect(error.message).toContain("tx()");
        expect(env.rec.log).toEqual([]);
        expect(await names(env)).toEqual(before);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "inside tx() the same restore and expect still work, and a failure rolls back",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const db = await seed(env);
      // A blocked restore fails with kind invalid and takes the transaction with it.
      const blocked = await refused(() =>
        db.tx(async (t: Loose) => {
          await t.orgs.insert({ id: key("o", 1), name: "extra" });
          await t.projects.onlyArchived().restore({ where: { id: key("p", 0) } });
        }),
      );
      expect(blocked.kind).toBe("invalid");
      expect(await names(env)).toEqual(["n0"]);
      // A wrong expect fails with kind not_found and also rolls back.
      const wrong = await refused(() =>
        db.tx(async (t: Loose) => {
          await t.orgs.insert({ id: key("o", 1), name: "extra" });
          await t.orgs.update({ where: { id: key("o", 0) }, set: { name: "x" } }, { expect: 5 });
        }),
      );
      expect(wrong.kind).toBe("not_found");
      expect(await names(env)).toEqual(["n0"]);
      // Restore the org, then the project, with expect, in one transaction.
      const out = await db.tx(async (t: Loose) => {
        const org = await t.orgs.onlyArchived().restore({ where: { id: key("o", 0) } });
        const project = await t.projects
          .onlyArchived()
          .restore({ where: { id: key("p", 0) } })
          .expect(0);
        return [org, project];
      });
      expect(out[0]).toEqual({ count: 1 });
      expect(out[1]).toEqual({ count: 0 });
    });
  },
  60_000,
);

const docs = table(
  "docs",
  { id: t.text().primaryKey(), title: t.text() },
  { traits: [versioned()] },
);
const versionedApp = schema({ casing: "snake", tables: [docs] });

postgresTest(
  gate,
  "db.batch refuses a versioned update with OKM1121, tx.batch still checks it",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(versionedApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), {
        schema: versionedApp,
        searchPath: schemaName,
        max: 1,
      }) as unknown as Loose;
      try {
        await db.connected;
        await db.docs.insert([
          { id: "a", title: "a" },
          { id: "b", title: "b" },
        ]);
        const titles = async (): Promise<string[]> =>
          (await sql.unsafe("select title from docs order by id")).map((row) => String(row.title));

        // The version is current and the version is stale: both are refused, nothing is sent.
        for (const version of [1, 9]) {
          const error = await refused(() =>
            db.batch([
              db.docs.insert({ id: "c", title: "extra" }),
              db.docs.update({ where: { id: "a" }, set: { title: "x" }, version }),
            ]),
          );
          expect(error.code).toBe("OKM1121");
          expect(error.message).toContain("version");
          expect(error.message).toContain("tx()");
          expect(await titles()).toEqual(["a", "b"]);
        }
        // A per-row list carries its versions too.
        const list = await refused(() =>
          db.batch([
            db.docs.update([
              { id: "a", set: { title: "x" }, version: 1 },
              { id: "b", set: { title: "y" }, version: 1 },
            ]),
          ]),
        );
        expect(list.code).toBe("OKM1121");
        expect(await titles()).toEqual(["a", "b"]);

        // A claim that does not check a version is still a batch member.
        await db.batch([
          db.docs.update({
            where: { id: "a" },
            set: { title: "free" },
            version: "any",
            lock: "skip",
            limit: 1,
          }),
        ]);
        expect(await titles()).toEqual(["free", "b"]);

        // Inside tx(), the batch checks the version and a stale one fails the transaction.
        const stale = await refused(() =>
          db.tx(async (tx: Loose) => {
            await tx.batch([
              tx.docs.insert({ id: "c", title: "extra" }),
              tx.docs.update({ where: { id: "b" }, set: { title: "late" }, version: 9 }),
            ]);
          }),
        );
        expect(stale.category).toBe("conflict");
        expect(await titles()).toEqual(["free", "b"]);
        await db.tx(async (tx: Loose) => {
          await tx.batch([
            tx.docs.insert({ id: "c", title: "extra" }),
            tx.docs.update({ where: { id: "b" }, set: { title: "ok" }, version: 1 }),
          ]);
        });
        expect(await titles()).toEqual(["free", "ok", "extra"]);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
