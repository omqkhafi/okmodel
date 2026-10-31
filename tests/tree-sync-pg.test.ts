/**
 * Descendants, ancestors, and sync on Postgres.
 *
 * A cycle has to return. Two syncs of one row have to leave one of the two sets.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, TENANT_A, TENANT_B } from "./tree-sync-schema.js";

const gate = await loadPostgresGate();

type Db = ReturnType<typeof connect<typeof app>>;
type Scoped = ReturnType<Db["for"]>;

const row = (n: number): string =>
  `01890c5a-8f0e-7c3a-9b2d-6e4f1a0c${n.toString(16).padStart(4, "0")}`;

function byText(left: unknown, right: unknown): number {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

async function withApp(max: number, run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

async function catchError(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function seedTree(a: Scoped): Promise<void> {
  await a.nodes.insert({ id: row(1), name: "root", parentId: null, managerId: null });
  await a.nodes.insert({ id: row(2), name: "mid", parentId: row(1), managerId: row(1) });
  await a.nodes.insert({ id: row(3), name: "keep", parentId: row(2), managerId: null });
  await a.nodes.insert({ id: row(4), name: "drop", parentId: row(2), managerId: null });
  await a.nodes.insert({ id: row(5), name: "other", parentId: row(1), managerId: null });
}

postgresTest(
  gate,
  "a depth limit, a root, and a missing id all return",
  async () => {
    await withApp(1, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.nodes.insert({ id: row(1), name: "a", parentId: null, managerId: null });
      await a.nodes.insert({ id: row(2), name: "b", parentId: row(1), managerId: null });
      expect(
        await a.nodes.ancestors(row(1), { relation: "children", limit: 20, depth: 0 }),
      ).toEqual([]);
      expect(
        (
          await a.nodes.descendants(row(1), {
            relation: "children",
            limit: 20,
            depth: 0,
            self: true,
          })
        ).map((item) => item.id),
      ).toEqual([row(1)]);
      await a.nodes.insert({ id: row(3), name: "root", parentId: null, managerId: null });
      expect(await a.nodes.ancestors(row(3), { relation: "children", limit: 20 })).toEqual([]);
      expect(
        (await a.nodes.ancestors(row(3), { relation: "children", limit: 20, self: true })).map(
          (item) => item.name,
        ),
      ).toEqual(["root"]);
      const missing = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0cffff";
      expect(
        await a.nodes.descendants(missing, { relation: "children", limit: 20, self: true }),
      ).toEqual([]);
    });
  },
  15_000,
);

postgresTest(
  gate,
  "a tree update refuses a direct and an indirect cycle, and a valid move works",
  async () => {
    await withApp(1, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.nodes.insert({ id: row(1), name: "root", parentId: null, managerId: null });
      await a.nodes.insert({ id: row(2), name: "mid", parentId: row(1), managerId: null });
      await a.nodes.insert({ id: row(3), name: "leaf", parentId: row(2), managerId: null });
      await a.nodes.insert({ id: row(4), name: "sib", parentId: row(1), managerId: null });
      const direct = await catchError(
        a.nodes.update({ where: { id: row(2) }, set: { parentId: row(2) } }),
      );
      expect(direct.code).toBe("OKM1120");
      expect(direct.message).toContain("tree");
      const indirect = await catchError(
        a.nodes.update({ where: { id: row(1) }, set: { parentId: row(3) } }),
      );
      expect(indirect.code).toBe("OKM1120");
      expect(indirect.message).toContain("descendant");
      expect((await a.nodes.find({ where: { id: row(1) }, limit: 1 }))[0]?.parentId).toBeNull();
      await a.nodes.update({ where: { id: row(3) }, set: { parentId: row(4) } });
      expect((await a.nodes.find({ where: { id: row(3) }, limit: 1 }))[0]?.parentId).toBe(row(4));
    });
  },
  15_000,
);

postgresTest(
  gate,
  "where and a preset filter the rows, and tenancy and archive filter the walk",
  async () => {
    await withApp(1, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await seedTree(a);
      await b.nodes.insert({ id: row(1), name: "other-tenant", parentId: null, managerId: null });
      await b.nodes.insert({ id: row(9), name: "hidden", parentId: row(1), managerId: null });
      const names = async (rows: readonly { readonly name: string }[]) =>
        rows.map((item) => item.name);
      expect(
        await names(await a.nodes.descendants(row(1), { relation: "children", limit: 20 })),
      ).toEqual(["mid", "other", "keep", "drop"]);
      expect(
        await names(
          await a.nodes.descendants(row(1), { relation: "children", limit: 20, depth: 1 }),
        ),
      ).toEqual(["mid", "other"]);
      expect(
        await names(
          await a.nodes.descendants(row(1), {
            relation: "children",
            limit: 20,
            where: { name: "keep" },
          }),
        ),
      ).toEqual(["keep"]);
      expect(
        await names(
          await a.nodes.called("keep").descendants(row(1), { relation: "children", limit: 20 }),
        ),
      ).toEqual(["keep"]);
      expect(
        await names(await a.nodes.descendants(row(1), { relation: "reports", limit: 20 })),
      ).toEqual(["mid"]);
      const selected = await a.nodes.descendants(row(3), {
        relation: "children",
        limit: 20,
        select: ["id", "name"],
        self: true,
      });
      expect(Object.keys(selected[0] ?? {}).sort()).toEqual(["id", "name"]);
      expect(
        await names(
          await a.nodes.ancestors(row(3), {
            relation: "children",
            limit: 20,
            orderBy: { name: "desc" },
          }),
        ),
      ).toEqual(["root", "mid"]);
      await a.nodes.archive({ where: { id: row(2) } });
      expect(
        await names(await a.nodes.descendants(row(1), { relation: "children", limit: 20 })),
      ).toEqual(["other"]);
      expect(await a.nodes.descendants(row(1), { relation: "children", limit: 20 })).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "hidden" })]),
      );
    });
  },
  15_000,
);

postgresTest(
  gate,
  "sync sets a join table exactly, including duplicates, missing ids, and two concurrent callers",
  async () => {
    await withApp(2, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.tags.insert({ id: row(1), name: "t" });
      await a.tags.insert({ id: row(8), name: "other" });
      for (const n of [2, 3, 4]) {
        await a.nodes.insert({
          id: row(n),
          name: `n${String(n)}`,
          parentId: null,
          managerId: null,
        });
      }
      const links = async () =>
        (await a.nodeTags.find({ where: { tagId: row(1) }, limit: 10 }))
          .map((item) => item.nodeId)
          .sort();
      const first = await a.tags.sync(row(1), "nodes", [row(2), row(3)]);
      expect(first.added.toSorted(byText)).toEqual([row(2), row(3)].sort(byText));
      expect(first.removed).toEqual([]);
      const second = await a.tags.sync(row(1), "nodes", [row(3), row(4)]);
      expect(second.added).toEqual([row(4)]);
      expect(second.removed).toEqual([row(2)]);
      const again = await a.tags.sync(row(1), "nodes", [row(4), row(3), row(3)]);
      expect(again).toEqual({ added: [], removed: [] });
      expect(await links()).toEqual([row(3), row(4)].sort());
      const missing = await catchError(a.tags.sync(row(1), "nodes", [row(3), row(9)]));
      expect(missing.kind).toBe("not_found");
      expect(missing.message).toContain("missing 1");
      expect(await links()).toEqual([row(3), row(4)].sort());
      const gone = await catchError(a.tags.sync(row(9), "nodes", []));
      expect(gone.kind).toBe("not_found");
      expect(await links()).toEqual([row(3), row(4)].sort());
      const named = await catchError(a.tags.named("other").sync(row(1), "nodes", []));
      expect(named.kind).toBe("not_found");
      expect(await links()).toEqual([row(3), row(4)].sort());
      await a.tags.sync(row(1), "nodes", [row(3)]).expect(1);
      expect(await links()).toEqual([row(3)]);
      const wrong = await catchError(
        a.tx(async (tx) => {
          await tx.tags.sync(row(1), "nodes", []).expect(9);
        }),
      );
      expect(wrong.kind).toBe("not_found");
      expect(wrong.message).toContain("expect was 9");
      expect(await links()).toEqual([row(3)]);
      await a.tags.sync(row(1), "nodes", []);
      expect(await links()).toEqual([]);

      await a.tags.sync(row(1), "nodes", [row(2)]);
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const left = a.tx(async (tx) => {
        await tx.tags.sync(row(1), "nodes", [row(2), row(3)]);
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      await held;
      const right = a.tx(async (tx) => tx.tags.sync(row(1), "nodes", [row(3), row(4)]));
      await Promise.all([left, right]);
      expect(await links()).toEqual([row(3), row(4)].sort());
    });
  },
  20_000,
);

postgresTest(
  gate,
  "sync sets a nullable foreign key and refuses a link that would delete a row",
  async () => {
    await withApp(1, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.folders.insert({ id: row(1), name: "a" });
      await a.folders.insert({ id: row(2), name: "b" });
      await a.files.insert({ id: row(3), name: "one", folderId: null });
      await a.files.insert({ id: row(4), name: "two", folderId: row(2) });
      await a.files.insert({ id: row(5), name: "three", folderId: null });
      const set = await a.folders.sync(row(1), "files", [row(3), row(4)]);
      expect(set.added.toSorted(byText)).toEqual([row(3), row(4)].sort(byText));
      expect((await a.files.one({ where: { id: row(4) } }))?.folderId).toBe(row(1));
      const cleared = await a.folders.sync(row(1), "files", [row(3)]);
      expect(cleared.removed).toEqual([row(4)]);
      const kept = await a.files.one({ where: { id: row(4) } });
      expect(kept?.folderId).toBeNull();
      expect(kept?.name).toBe("two");
      await a.items.insert({ id: row(6), name: "item", ownerId: row(1) });
      const refused = await catchError(a.folders.sync(row(1), "items", []));
      expect(refused.code).toBe("OKM1120");
      expect((await a.items.one({ where: { id: row(6) } }))?.ownerId).toBe(row(1));
      await a.nodes.insert({ id: row(7), name: "n", parentId: null, managerId: null });
      await a.tags.insert({ id: row(8), name: "t" });
      const extra = await catchError(a.tags.sync(row(8), "noted", [row(7)]));
      expect(extra.code).toBe("OKM1120");
      expect(await a.badLinks.find({ limit: 5 })).toEqual([]);
      const one = await catchError(a.files.sync(row(3), "folder", []));
      expect(one.code).toBe("OKM1120");
    });
  },
  15_000,
);

postgresTest(gate, "a row cannot be its own child", async () => {
  await withApp(1, async (db) => {
    const a = db.for({ tenantId: TENANT_A });
    await seedTree(a);
    const before = (await a.nodes.find({ where: { id: row(2) }, limit: 1 }))[0]?.parentId;
    const error = await catchError(a.nodes.sync(row(1), "children", [row(1)]));
    expect(error.code).toBe("OKM1120");
    expect(error.message).toContain("tree");
    expect((await a.nodes.find({ where: { id: row(2) }, limit: 1 }))[0]?.parentId).toBe(before);
    expect((await a.nodes.find({ where: { id: row(5) }, limit: 1 }))[0]?.parentId).toBe(row(1));
    const normal = await a.nodes.sync(row(1), "children", [row(2)]);
    expect(normal.removed).toEqual([row(5)]);
    expect((await a.nodes.find({ where: { id: row(2) }, limit: 1 }))[0]?.parentId).toBe(row(1));
    expect((await a.nodes.find({ where: { id: row(5) }, limit: 1 }))[0]?.parentId).toBeNull();
    const followed = await a.nodes.sync(row(1), "follows", [row(1), row(2)]);
    expect(followed.added.toSorted(byText)).toEqual([row(1), row(2)].sort(byText));
    expect(followed.removed).toEqual([]);
    const dropped = await a.nodes.sync(row(1), "follows", [row(1)]);
    expect(dropped.added).toEqual([]);
    expect(dropped.removed).toEqual([row(2)]);
    const cycle = await catchError(
      a.nodes.update({ where: { id: row(2) }, set: { parentId: row(2) } }),
    );
    expect(cycle.code).toBe("OKM1120");
    expect(cycle.message).toContain("tree");
    expect((await a.nodes.find({ where: { id: row(2) }, limit: 1 }))[0]?.parentId).toBe(row(1));
    await a.nodes.update({ where: { name: "mid" }, set: { name: "mid" } });
  });
});
