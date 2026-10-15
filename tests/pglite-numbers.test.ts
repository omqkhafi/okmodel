/**
 * PGlite accepts a JS number or bigint on a bigint column.
 *
 * The string codec used to hand the original value to the driver, and the
 * protocol error came back as unavailable. Wire text is the driver's job.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { bigint, boolean, many, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";

const nodes = table(
  "nodes",
  {
    id: bigint().primaryKey(),
    parentId: bigint().nullable().references("nodes"),
    name: text(),
    flag: boolean(),
  },
  { relations: { children: many("nodes", "parentId") } },
);

const numbered = table("numbered", {
  id: bigint({ as: "number" }).primaryKey(),
  name: text(),
});

const app = schema({ casing: "snake", tables: [nodes] });
const numberApp = schema({
  casing: "snake",
  codecs: { bigint: "number" },
  tables: [numbered],
});

type Db = Awaited<ReturnType<typeof connect<typeof app>>>;
type NumberDb = Awaited<ReturnType<typeof connect<typeof numberApp>>>;

/**
 * Keeps a JS number or bigint at runtime.
 *
 * The string codec's public type is string. The driver still receives the
 * original value, which is the case under test.
 *
 * @param id - Numeric id
 * @returns That same value, typed as the column's string
 */
function runtimeId(id: number | bigint): string {
  return id as never;
}

async function caught(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

test("a number or bigint id round-trips, and a protocol error is not unavailable", async () => {
  const pool = await openPglite();
  let db: Db | undefined;
  let poolClosed = false;
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    for (const statement of renderCatalog(numberApp.catalog, "public")) {
      await pool.execute(statement);
    }
    db = await connect(pool, { schema: app });
    await db.connected;
    const numbers: NumberDb = await connect(pool, { schema: numberApp });
    await numbers.connected;

    await db.nodes.insert({ id: "1", parentId: null, name: "root", flag: true });
    await db.nodes.insert({ id: "2", parentId: "1", name: "mid", flag: false });
    await db.nodes.insert({ id: "3", parentId: "2", name: "leaf", flag: true });
    await db.nodes.insert({ id: "4", parentId: null, name: "spare", flag: false });

    expect((await db.nodes.find({ where: { id: runtimeId(2) }, limit: 1 }))[0]?.name).toBe("mid");
    expect((await db.nodes.find({ where: { id: runtimeId(3n) }, limit: 1 }))[0]?.name).toBe("leaf");
    expect(
      (await db.nodes.find({ where: { id: runtimeId(1), flag: true }, limit: 1 }))[0]?.name,
    ).toBe("root");
    expect(
      (await db.nodes.find({ where: { id: runtimeId(2), flag: false }, limit: 1 }))[0]?.name,
    ).toBe("mid");

    expect(
      (await db.nodes.update({ where: { id: runtimeId(2) }, set: { name: "renamed" } })).count,
    ).toBe(1);
    expect(
      (await db.nodes.update({ where: { id: runtimeId(3n) }, set: { name: "renamed-big" } })).count,
    ).toBe(1);
    expect((await db.nodes.find({ where: { id: runtimeId(2) }, limit: 1 }))[0]?.name).toBe(
      "renamed",
    );

    const down = await db.nodes.descendants(1);
    const downBig = await db.nodes.descendants(1n);
    expect(down.map((row) => row.id).sort()).toEqual(["2", "3"]);
    expect(downBig.map((row) => row.id).sort()).toEqual(["2", "3"]);
    const up = await db.nodes.ancestors(3);
    const upBig = await db.nodes.ancestors(3n);
    expect(up.map((row) => row.id).sort()).toEqual(["1", "2"]);
    expect(upBig.map((row) => row.id).sort()).toEqual(["1", "2"]);

    const streamed: string[] = [];
    for await (const row of db.nodes.find({ where: { id: runtimeId(2) }, limit: 5 }).stream()) {
      streamed.push(row.id);
    }
    const streamedBig: string[] = [];
    for await (const row of db.nodes.find({ where: { id: runtimeId(3n) }, limit: 5 }).stream()) {
      streamedBig.push(row.id);
    }
    expect(streamed).toEqual(["2"]);
    expect(streamedBig).toEqual(["3"]);

    await db.nodes.insert({ id: "5", parentId: "1", name: "extra", flag: true });
    const cleared = await db.nodes.sync(1, "children", [runtimeId(2)]);
    expect(cleared.removed).toEqual(["5"]);
    expect(
      (await db.nodes.find({ where: { id: runtimeId(5) }, limit: 1 }))[0]?.parentId,
    ).toBeNull();
    const restored = await db.nodes.sync(1n, "children", [runtimeId(2n), runtimeId(5n)]);
    expect(restored.added).toEqual(["5"]);
    expect((await db.nodes.find({ where: { id: runtimeId(5) }, limit: 1 }))[0]?.parentId).toBe("1");

    expect((await db.nodes.delete({ where: { id: runtimeId(4) } })).count).toBe(1);
    await db.nodes.insert({ id: "6", parentId: null, name: "gone", flag: false });
    expect((await db.nodes.delete({ where: { id: runtimeId(6n) } })).count).toBe(1);
    expect(await db.nodes.find({ where: { id: runtimeId(4) }, limit: 1 })).toEqual([]);
    expect(await db.nodes.find({ where: { id: runtimeId(6n) }, limit: 1 })).toEqual([]);

    await numbers.numbered.insert({ id: 7, name: "seven" });
    expect((await numbers.numbered.find({ where: { id: 7 }, limit: 1 }))[0]?.id).toBe(7);
    expect(
      (await numbers.numbered.update({ where: { id: 7 }, set: { name: "seven-b" } })).count,
    ).toBe(1);
    expect((await numbers.numbered.find({ where: { id: 7 }, limit: 1 }))[0]?.name).toBe("seven-b");

    const yes = await pool.execute("select $1::bool", [true as never]);
    const no = await pool.execute("select $1::bool", [false as never]);
    expect(yes.rows[0]?.[0]).toBe("t");
    expect(no.rows[0]?.[0]).toBe("f");

    const protocol = await caught(pool.execute("select $1::int", [{}] as never));
    expect(protocol).toBeInstanceOf(DriverError);
    if (!(protocol instanceof DriverError)) throw new Error("expected DriverError");
    expect(protocol.sqlstate).toBeUndefined();
    const mapped = mapPostgresError(protocol);
    expect(mapped.kind).toBe("driver");
    expect(mapped.retryable).toBe(false);

    await pool.close();
    poolClosed = true;
    const closed = await caught(db.nodes.find({ limit: 1 }));
    expect(closed).toBeInstanceOf(OkmError);
    if (!(closed instanceof OkmError)) throw new Error("expected OkmError");
    expect(closed.kind).toBe("unavailable");
    expect(closed.sqlstate).toBe("08006");
  } finally {
    await db?.close();
    if (!poolClosed) await pool.close();
  }
}, 30_000);
