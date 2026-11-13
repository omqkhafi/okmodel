/**
 * Keyset comparisons for NOT NULL keys stay on the primary-key index.
 *
 * A nullable order column keeps the `is null` branch. Real Postgres.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { integer, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const rows = table("rows", {
  id: integer().primaryKey(),
  label: text().nullable(),
  rank: integer(),
  token: text().sensitive(),
  code: text().nullable().hidden({ filterable: true }),
});

const bulk = table("bulk", {
  id: integer().primaryKey(),
  label: text().nullable(),
});

const items = table("items", {
  id: integer().primaryKey(),
  label: text().nullable(),
});

const app = schema({ tables: [rows, bulk, items] });

/**
 * Cursor `page()` returned for `rows.id = 1` before NOT NULL keys dropped
 * the null branch. The payload is `["rows:id.asc.last","1"]`.
 */
const PREVIOUS_CURSOR = "WyJyb3dzOmlkLmFzYy5sYXN0IiwiMSJd";

/** Rows a deep keyset may still discard. The old `or id is null` filter removed the prefix. */
const FILTER_ROW_CEILING = 8;

const BULK_ROWS = 200_000;
const DEEP_ID = 180_000;

const gate = await loadPostgresGate();

type Item = { readonly id: number; readonly label: string | null };

type KeysetPage = {
  readonly items: readonly Item[];
  readonly next: string | null;
};

function encodeCursor(value: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function filterRowsRemoved(plan: string): number {
  let highest = 0;
  for (const match of plan.matchAll(/Rows Removed by Filter: (\d+)/g)) {
    const count = Number(match[1]);
    if (Number.isFinite(count) && count > highest) highest = count;
  }
  return highest;
}

postgresTest(gate, "keyset sql keeps is null only on a nullable key", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    await sql.unsafe(
      `insert into ${schemaName}."rows" ("id", "label", "rank", "token") values (1, 'a', 1, 't1'), (2, 'a', 2, 't2'), (3, null, 3, 't3')`,
    );
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    await db.connected;
    try {
      const first = await db.rows.page({ select: ["id"], orderBy: { id: "asc" }, limit: 1 });
      expect(first.next).toBe(PREVIOUS_CURSOR);
      const accepted = await db.rows.page({
        select: ["id"],
        orderBy: { id: "asc" },
        limit: 2,
        after: PREVIOUS_CURSOR,
      });
      expect(accepted.items.map((row) => row.id)).toEqual([2, 3]);

      const primary = await db.rows
        .page({ select: ["id"], orderBy: { id: "asc" }, limit: 2, after: PREVIOUS_CURSOR })
        .sql();
      expect(primary.text).toBe(
        'select t."id" from "rows" t where ((t."id" > $1)) order by t."id" asc nulls last limit $2',
      );
      expect(primary.text.includes("is null")).toBe(false);
      expect(primary.params).toEqual(["1", "3"]);

      const nullable = await db.rows
        .page({
          select: ["id", "label"],
          orderBy: { label: "asc" },
          limit: 2,
          after: encodeCursor(["rows:label.asc.last,id.asc.last", "a", "2"]),
        })
        .sql();
      expect(nullable.text).toBe(
        'select t."id", t."label" from "rows" t where (((t."label" > $1 or t."label" is null)) or (t."label" = $2 and t."id" > $3)) order by t."label" asc nulls last, t."id" asc nulls last limit $4',
      );
      expect(nullable.params).toEqual(["a", "a", "2", "3"]);

      const ranked = await db.rows
        .page({
          select: ["id"],
          orderBy: { rank: "asc" },
          limit: 2,
          after: encodeCursor(["rows:rank.asc.last,id.asc.last", "4", "2"]),
        })
        .sql();
      expect(ranked.text.includes("is null")).toBe(false);
      expect(ranked.text).toContain('t."rank" > $1');
      expect(ranked.text).toContain('t."id" > $3');

      const hidden = await db.rows
        .page({
          select: ["id"],
          orderBy: { token: "asc" },
          limit: 2,
          after: encodeCursor(["k", "rows:token.asc.last,id.asc.last", "1"]),
        })
        .sql();
      expect(hidden.text.includes(" is null")).toBe(false);

      const hiddenNull = await db.rows
        .page({
          select: ["id"],
          orderBy: { code: "asc" },
          limit: 2,
          after: encodeCursor(["k", "rows:code.asc.last,id.asc.last", "1"]),
        })
        .sql();
      expect(hiddenNull.text).toContain(" is null");
      expect(hiddenNull.text.includes('"id" is null')).toBe(false);
    } finally {
      await db.close();
    }
  });
});

postgresTest(
  gate,
  "a deep keyset page uses the primary-key index",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      await sql.unsafe(
        `insert into ${schemaName}."bulk" ("id", "label")
         select g, case when g % 17 = 0 then null else 'v' end
         from generate_series(1, ${String(BULK_ROWS)}) g`,
      );
      await sql.unsafe(`analyze ${schemaName}."bulk"`);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      await db.connected;
      try {
        const after = encodeCursor(["bulk:id.asc.last", String(DEEP_ID)]);
        const page = await db.bulk.page({
          select: ["id"],
          orderBy: { id: "asc" },
          limit: 1,
          after,
        });
        expect(page.items[0]?.id).toBe(DEEP_ID + 1);
        const planned = await db.bulk
          .page({
            select: ["id"],
            orderBy: { id: "asc" },
            limit: 1000,
            after,
          })
          .sql();
        expect(planned.text.includes("is null")).toBe(false);
        const explained = await sql.unsafe(`explain (analyze, buffers) ${planned.text}`, [
          ...planned.params,
        ]);
        const plan = explained
          .map((row) => row["QUERY PLAN"])
          .filter((line): line is string => typeof line === "string")
          .join("\n");
        expect(plan).toContain("Index Cond");
        expect(plan).toMatch(/Index Cond:.*\bid\b/);
        expect(filterRowsRemoved(plan)).toBeLessThanOrEqual(FILTER_ROW_CEILING);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "stream and page walk nullable keys, including inserts between batches",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const seed: { id: number; label: string | null }[] = [];
      for (let id = 1; id <= 120; id += 1) {
        const label = id % 10 === 0 ? null : id % 3 === 0 ? "a" : id % 3 === 1 ? "b" : "c";
        seed.push({ id, label });
      }
      await sql.unsafe(
        `insert into ${schemaName}."items" ("id", "label") values ${seed
          .map((row) => `(${String(row.id)}, ${row.label === null ? "null" : `'${row.label}'`})`)
          .join(", ")}`,
      );
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      await db.connected;
      try {
        for (const direction of ["asc", "desc"] as const) {
          const orderBy = { label: direction, id: "asc" } as const;
          const oracle = (await db.items.find({ orderBy }).all("oracle")) as Item[];
          const streamed: Item[] = [];
          for await (const row of db.items.find({ orderBy }).all("walk").stream({ batch: 7 })) {
            streamed.push(row as Item);
          }
          expect(streamed.map((row) => row.id)).toEqual(oracle.map((row) => row.id));
          const paged: number[] = [];
          let after: string | null = null;
          for (let guard = 0; guard < 40; guard += 1) {
            const batch: KeysetPage = await db.items.page({ orderBy, limit: 7, after });
            paged.push(...batch.items.map((row) => row.id));
            if (batch.next === null) break;
            after = batch.next;
            if (guard === 39) throw new Error("page() did not end");
          }
          expect(paged).toEqual(oracle.map((row) => row.id));
          expect(new Set(paged).size).toBe(paged.length);
          if (direction === "asc") expect(streamed.at(-1)?.label).toBeNull();
          if (direction === "desc") expect(streamed[0]?.label).toBeNull();
        }

        await proveInserts(db, sql, schemaName, "asc");
        await proveInserts(db, sql, schemaName, "desc");
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

async function proveInserts(
  db: ReturnType<typeof connect<typeof app>>,
  sql: { unsafe(text: string): Promise<unknown> },
  schemaName: string,
  direction: "asc" | "desc",
): Promise<void> {
  const orderBy = { label: direction, id: "asc" } as const;
  const oracle = ((await db.items.find({ orderBy }).all("oracle")) as Item[]).map((row) => row.id);
  const early = direction === "asc" ? `(0, 'a')` : `(0, null)`;
  const insert = `insert into ${schemaName}."items" ("id", "label") values ${early}, (1001, 'd')`;
  const remove = `delete from ${schemaName}."items" where "id" in (0, 1001)`;

  const streamed: number[] = [];
  let seeded = false;
  for await (const row of db.items.find({ orderBy }).all("walk").stream({ batch: 8 })) {
    streamed.push((row as Item).id);
    if (!seeded && streamed.length === 8) {
      await sql.unsafe(insert);
      seeded = true;
    }
  }
  expect(seeded).toBe(true);
  expect(originals(streamed, oracle)).toEqual(oracle);
  expect(streamed.includes(0)).toBe(false);
  expect(streamed.filter((id) => id === 1001)).toEqual([1001]);
  await sql.unsafe(remove);

  const paged: number[] = [];
  let after: string | null = null;
  let inserted = false;
  for (let guard = 0; guard < 40; guard += 1) {
    const batch: KeysetPage = await db.items.page({ orderBy, limit: 8, after });
    paged.push(...batch.items.map((row) => row.id));
    if (!inserted) {
      await sql.unsafe(insert);
      inserted = true;
    }
    if (batch.next === null) break;
    after = batch.next;
  }
  expect(originals(paged, oracle)).toEqual(oracle);
  expect(paged.includes(0)).toBe(false);
  expect(paged.filter((id) => id === 1001)).toEqual([1001]);
  await sql.unsafe(remove);
}

function originals(seen: readonly number[], oracle: readonly number[]): number[] {
  const known = new Set(oracle);
  return seen.filter((id) => known.has(id));
}
