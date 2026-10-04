/**
 * Presets: statement text, provenance, name rules, and the contract with the
 * planner. Each case runs on PGlite. Real Postgres is `presets-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { trait } from "../src/runtime/traits/index.js";
import { ADA, GRACE, TENANT_A, TENANT_B, app, flagged, tenantApp } from "./presets-schema.js";

async function open() {
  const pool = await openPglite();
  for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
  const db = await connect(pool, { schema: app });
  await db.connected;
  return { db, pool };
}

async function openTenant() {
  const pool = await openPglite();
  for (const statement of renderCatalog(tenantApp.catalog, "public")) {
    await pool.execute(statement);
  }
  const db = await connect(pool, { schema: tenantApp });
  await db.connected;
  return { db, pool };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.code : undefined;
}

test("each preset kind adds its predicate after the caller's and the active set", async () => {
  const { db, pool } = await open();
  try {
    const plain = await db.tasks.pending().find({ limit: 1 }).sql();
    expect(plain.text).toContain('where t."archived_at" is null and t."status" = $1');
    expect(plain.params).toEqual(["pending", "1"]);

    const argument = await db.tasks.ownedBy(ADA).find({ limit: 1 }).sql();
    expect(argument.text).toContain('t."owner_id" = $1');
    expect(argument.params[0]).toBe(ADA);

    const operator = await db.tasks.urgent().find({ limit: 1 }).sql();
    expect(operator.text).toContain('t."priority" >= $1');

    const rest = await db.tasks.inState("open", "pending").find({ limit: 1 }).sql();
    expect(rest.text).toContain('t."status" in ($1, $2)');

    const either = await db.tasks.mineOrOpen(ADA).find({ limit: 1 }).sql();
    expect(either.text).toContain('((t."owner_id" = $1) or (t."status" = $2))');

    const twice = await db.tasks.stale().find({ limit: 1 }).sql();
    expect(twice.text).toContain('t."status" = $1 and t."priority" >= $2');

    const trait = await db.tasks.flagged().find({ limit: 1 }).sql();
    expect(trait.text).toContain('t."flagged" = $1');
  } finally {
    await db.close();
    await pool.close();
  }
});

test("presets chain, and the caller's where stays with them", async () => {
  const { db, pool } = await open();
  try {
    const chained = await db.tasks
      .pending()
      .ownedBy(ADA)
      .urgent()
      .find({ where: { title: "ship" }, limit: 3 })
      .sql();
    expect(chained.text).toContain(
      'where t."archived_at" is null and t."title" = $1 and t."status" = $2 and t."owner_id" = $3 and t."priority" >= $4',
    );
    expect(chained.params).toEqual(["ship", "pending", ADA, "3", "3"]);

    const same = await db.tasks
      .pending()
      .find({ where: { status: "open" }, limit: 1 })
      .sql();
    expect(same.text).toContain('t."status" = $1 and t."status" = $2');
    expect(same.params.slice(0, 2)).toEqual(["open", "pending"]);

    const reused = db.tasks.pending();
    const first = await reused.ownedBy(ADA).count().sql();
    const second = await reused.ownedBy(GRACE).count().sql();
    expect(first.params).toEqual(["pending", ADA]);
    expect(second.params).toEqual(["pending", GRACE]);
    expect((await reused.count().sql()).params).toEqual(["pending"]);
  } finally {
    await db.close();
    await pool.close();
  }
});

test("a preset works on every read and on update, delete, archive, and restore", async () => {
  const { db, pool } = await open();
  try {
    const view = db.tasks.pending();
    expect((await view.one({ where: { id: ADA } }).sql()).text).toContain('t."status" = $');
    expect((await view.count().sql()).text).toContain('t."status" = $');
    expect((await view.exists().sql()).text).toContain('t."status" = $');
    expect(
      (await view.aggregate({ count: true, groupBy: ["ownerId"], limit: 5 }).sql()).text,
    ).toContain('t."status" = $');
    expect((await view.page({ orderBy: { priority: "asc" }, limit: 2 }).sql()).text).toContain(
      't."status" = $',
    );

    const update = await view.update({ where: { id: ADA }, set: { title: "x" } }).sql();
    expect(update.statements[0]?.text).toContain('t."id" = $2 and t."status" = $3');
    const list = await view
      .update([
        { where: { id: ADA }, set: { title: "a" } },
        { where: { id: GRACE }, set: { title: "b" } },
      ])
      .sql();
    const text = list.statements[0]?.text ?? "";
    expect(text.match(/t\."status" = /g)?.length).toBe(4);
    const removed = await view.delete({ where: { id: ADA } }).sql();
    expect(removed.statements[0]?.text).toContain('t."id" = $1 and t."status" = $2');

    const archived = await view.archive({ where: { id: ADA } }).sql();
    expect(archived.statements[0]?.text).toContain('t."id" = $2 and t."status" = $3');
    const restored = await view
      .onlyArchived()
      .restore({ where: { id: ADA } })
      .sql();
    expect(restored.statements[0]?.text).toContain('"archived_at" is not null');
    expect(restored.statements[0]?.text).toContain('t."status" = $');
  } finally {
    await db.close();
    await pool.close();
  }
});

test("update and delete still need a where, and a preset does not stand in for one", async () => {
  const { db, pool } = await open();
  try {
    let refused: unknown;
    try {
      await db.tasks.pending().delete({} as never);
    } catch (error) {
      refused = error;
    }
    expect(codeOf(refused)).toBe("OKM1102");

    const all = await db.tasks.pending().delete({}).all("clear the backlog").sql();
    expect(all.statements[0]?.text).toContain('where t."archived_at" is null and t."status" = $1');
  } finally {
    await db.close();
    await pool.close();
  }
});

test("the tenant predicate and the active set stay around any chain", async () => {
  const { db, pool } = await openTenant();
  try {
    const scoped = db.for({ tenantId: TENANT_A });
    const query = await scoped.tasks
      .pending()
      .mineOrOpen(ADA)
      .urgent()
      .find({ where: { title: "ship" }, limit: 4 })
      .sql();
    expect(query.text).toContain('where t."tenant_id" = $1 and t."archived_at" is null');
    expect(query.params[0]).toBe(TENANT_A);

    const update = await scoped.tasks
      .pending()
      .update({ where: { id: ADA }, set: { title: "x" } })
      .sql();
    expect(update.statements[0]?.text).toContain('t."tenant_id" = $');
    const removed = await scoped.tasks
      .ownedBy(ADA)
      .delete({ where: { id: ADA } })
      .sql();
    expect(removed.statements[0]?.text).toContain('t."tenant_id" = $');
    const archived = await scoped.tasks
      .ownedBy(ADA)
      .archive({ where: { id: ADA } })
      .sql();
    expect(archived.statements[0]?.text).toContain('t."tenant_id" = $');

    let foreign: unknown;
    try {
      await scoped.tasks
        .pending()
        .find({ where: { tenantId: TENANT_B } as never, limit: 1 })
        .sql();
    } catch (error) {
      foreign = error;
    }
    expect(codeOf(foreign)).toBe("OKM1704");
  } finally {
    await db.close();
    await pool.close();
  }
});

test("inspect names each preset, the fields it filters, and who added it", async () => {
  const { db, pool } = await open();
  try {
    const inspected = await db.tasks.pending().flagged().ownedBy(ADA).find({ limit: 1 }).inspect();
    const lines = inspected.rules.filter((rule) => rule.rule === "preset");
    expect(lines.map((rule) => rule.contribution)).toEqual([
      "pending filters status",
      "flagged filters flagged",
      "ownedBy filters ownerId",
    ]);
    expect(lines.map((rule) => rule.provenance)).toEqual([
      "table tasks",
      "trait flagged",
      "table tasks",
    ]);
    expect(lines[0]?.source).toMatch(/presets-schema\.ts:\d+/);
    expect(inspected.rules.some((rule) => rule.rule === "archive")).toBe(true);
    expect(inspected.sql.text).toContain('t."status" = $1');

    const plain = await db.tasks.find({ limit: 1 }).inspect();
    expect(plain.rules.some((rule) => rule.rule === "preset")).toBe(false);
  } finally {
    await db.close();
    await pool.close();
  }
});

test("a reserved or client-method name fails with OKM1040 in a trait, at build", () => {
  for (const name of ["find", "update", "lock", "watch", "as", "then", "withArchived"]) {
    let failure: unknown;
    try {
      trait("bad", { fields: {}, presets: { [name]: (q: never) => q } as never });
    } catch (error) {
      failure = error;
    }
    expect(codeOf(failure)).toBe("OKM1040");
    expect((failure as OkmError).message).toContain(name);
  }
});

test("a reserved name on a table fails with OKM1040 when the client connects", async () => {
  const bad = schema({
    tables: [
      table(
        "notes",
        { id: id({ default: "none" }), body: text() },
        // @ts-expect-error `find` is a client method
        { presets: { find: (q) => q.where({ body: "x" }) } },
      ),
    ],
  });
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(bad.catalog, "public")) await pool.execute(statement);
    const db = await connect(pool, { schema: bad });
    let failure: unknown;
    try {
      await db.connected;
    } catch (error) {
      failure = error;
    }
    expect(codeOf(failure)).toBe("OKM1040");
    expect((failure as OkmError).message).toContain("Preset find on table notes");
    await db.close();
  } finally {
    await pool.close();
  }
});

test("a name defined twice is OKM1040, and the fix names both sources", () => {
  const dup = trait("flagged2", {
    fields: {},
    presets: { pending: (q) => q.where({}) },
  });
  const other = trait("other", {
    fields: {},
    presets: { pending: (q) => q.where({}) },
  });
  const columns = { id: id({ default: "none" }), status: text() };

  let tableAndTrait: unknown;
  try {
    schema({
      tables: [
        table("a", columns, {
          traits: [dup],
          presets: { pending: (q) => q.where({ status: "x" }) },
        }),
      ],
    });
  } catch (error) {
    tableAndTrait = error;
  }
  expect(codeOf(tableAndTrait)).toBe("OKM1040");
  const first = tableAndTrait as OkmError;
  expect(first.message).toContain("table a");
  expect(first.message).toContain("trait flagged2");
  expect(first.fix?.summary).toContain("table a");
  expect(first.fix?.summary).toContain("trait flagged2");

  let twoTraits: unknown;
  try {
    schema({ tables: [table("b", columns, { traits: [dup, other] })] });
  } catch (error) {
    twoTraits = error;
  }
  expect(codeOf(twoTraits)).toBe("OKM1040");
  expect((twoTraits as OkmError).message).toContain("trait flagged2");
  expect((twoTraits as OkmError).message).toContain("trait other");

  const flaggedTwice = () =>
    schema({ tables: [table("c", columns, { traits: [flagged, flagged] })] });
  expect(flaggedTwice).toThrow();
});

test("a preset must return the builder it was given", async () => {
  const odd = schema({
    tables: [
      table(
        "notes",
        { id: id({ default: "none" }), body: text() },
        {
          presets: {
            nothing: (() => undefined) as never,
            other: ((_q: unknown) => ({ where: () => undefined })) as never,
          },
        },
      ),
    ],
  });
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(odd.catalog, "public")) await pool.execute(statement);
    const db = await connect(pool, { schema: odd });
    for (const name of ["nothing", "other"] as const) {
      let failure: unknown;
      try {
        await (db.notes as never as Record<string, () => { find(o: object): Promise<unknown> }>)
          [name]?.()
          .find({ limit: 1 });
      } catch (error) {
        failure = error;
      }
      expect(codeOf(failure)).toBe("OKM1121");
    }
    await db.close();
  } finally {
    await pool.close();
  }
});

test("a table with no presets carries no preset key and no preset methods", async () => {
  const { db, pool } = await open();
  try {
    const plain = schema({
      tables: [table("notes", { id: id({ default: "none" }), body: text() })],
    });
    expect("presets" in (plain.model.notes ?? {})).toBe(false);
    expect(Object.keys(db.tasks)).toContain("pending");
  } finally {
    await db.close();
    await pool.close();
  }
});

test("a schema-level trait's presets reach every table that keeps the defaults", async () => {
  const recent = trait("recent", {
    fields: {},
    presets: { quiet: (q) => q.where({}) },
  });
  const shared = schema({
    traits: [recent],
    tables: [
      table("notes", { id: id({ default: "none" }), body: text() }),
      table(
        "logs",
        { id: id({ default: "none" }), body: text() },
        { omitDefaults: "written outside okmodel" },
      ),
    ],
  });
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(shared.catalog, "public")) await pool.execute(statement);
    const db = await connect(pool, { schema: shared });
    await db.connected;
    expect(typeof db.notes.quiet).toBe("function");
    expect("quiet" in db.logs).toBe(false);
    expect((await db.notes.quiet().find({ limit: 1 }).sql()).text).toContain("from");
    await db.close();
  } finally {
    await pool.close();
  }
});
