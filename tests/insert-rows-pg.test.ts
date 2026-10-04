/**
 * An array insert takes rows with different key sets (P27b).
 *
 * An omitted key or an explicit `undefined` is `DEFAULT` for that row, in the
 * same statement. `null` stays NULL. Real Postgres.
 */

import { expect } from "bun:test";
import fc from "fast-check";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { boolean, id, integer, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { uuidv4 } from "../src/runtime/ids/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { v } from "../src/runtime/validate/index.js";
import { WRITE_PARAM_BUDGET } from "../src/runtime/write.js";

const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const OTHER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

function columns() {
  return {
    id: id({ default: uuidv4 }),
    idx: integer(),
    label: text().default("x"),
    score: integer().default(7),
    note: text().nullable(),
    flag: boolean().nullable().default(true),
  };
}

// `bulk` takes array inserts, `single` takes the same rows one by one
const bulk = table("bulk", columns());
const single = table("single", columns());
const generated = table("generated", {
  id: id({ default: "uuidv4" }),
  idx: integer(),
  label: text().default("x"),
});
const scoped = table(
  "scoped",
  {
    id: id({ default: uuidv4 }),
    title: text(),
    prio: integer().default(3),
    note: text().nullable(),
  },
  { traits: [archivable()] },
);

const slots = table("slots", {
  id: id({ default: uuidv4 }),
  idx: integer().unique(),
  label: text().default("x"),
  score: integer().default(7),
});
const checked = table(
  "checked",
  {
    id: id({ default: uuidv4 }),
    title: text().validate([v.min(1, "title_required")]),
    prio: integer().default(3),
  },
  { validation: true },
);

const plain = schema({
  casing: "snake",
  tables: [bulk, single, generated, slots, checked],
  validation: true,
});
const tenant = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [scoped],
});

const gate = await loadPostgresGate();

async function total(
  sql: Parameters<Parameters<typeof withPostgresSchema>[0]>[0],
  from: string,
): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${from}`);
  return rows[0]?.n ?? -1;
}

type Stored = {
  readonly idx: number;
  readonly label: string;
  readonly score: number;
  readonly note: string | null;
  readonly flag: boolean | null;
};

const STORED = "select idx, label, score, note, flag from";

postgresTest(
  gate,
  "rows with different key sets share one statement and take defaults per row",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(plain.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: plain, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const rows = [
          { idx: 1, label: "a", score: 1, note: "n", flag: false },
          { idx: 2 },
          { idx: 3, score: 3 },
          { idx: 4, label: undefined, score: undefined, note: undefined, flag: undefined },
          { idx: 5, note: null, flag: null },
          { idx: 6, label: "z", flag: undefined },
        ];
        const planned = await db.bulk.insert(rows).sql();
        expect(planned.statements).toHaveLength(1);
        expect(planned.statements[0]?.text.match(/\bdefault\b/g)?.length).toBeGreaterThan(6);

        const returned = await db.bulk.insert(rows, { returning: ["idx", "label", "score"] });
        expect(returned as unknown).toEqual([
          { idx: 1, label: "a", score: 1 },
          { idx: 2, label: "x", score: 7 },
          { idx: 3, label: "x", score: 3 },
          { idx: 4, label: "x", score: 7 },
          { idx: 5, label: "x", score: 7 },
          { idx: 6, label: "z", score: 7 },
        ]);
        const stored = await sql<Stored[]>`${sql.unsafe(`${STORED} bulk order by idx`)}`;
        expect(Array.from(stored)).toEqual([
          { idx: 1, label: "a", score: 1, note: "n", flag: false },
          { idx: 2, label: "x", score: 7, note: null, flag: true },
          { idx: 3, label: "x", score: 3, note: null, flag: true },
          { idx: 4, label: "x", score: 7, note: null, flag: true },
          { idx: 5, label: "x", score: 7, note: null, flag: null },
          { idx: 6, label: "z", score: 7, note: null, flag: true },
        ]);
        // a client-filled id is distinct on every row, with or without other keys
        const ids = await sql<{ id: string }[]>`select id from bulk`;
        expect(new Set(ids.map((row) => row.id)).size).toBe(6);

        // null into a NOT NULL column stays NULL and is refused; it never becomes the default
        const refused = await db.bulk.insert([{ idx: 7 }, { idx: 8, label: null as never }]).safe();
        expect(refused.ok).toBe(false);
        expect(await total(sql, "bulk")).toBe(6);

        // a database-generated id and rows that write nothing but the key
        const made = await db.generated.insert([{ idx: 1 }, { idx: 2, label: "y" }, { idx: 3 }], {
          returning: ["id", "idx", "label"],
        });
        expect(new Set(made.map((row) => row.id)).size).toBe(3);
        expect(made.map((row) => row.label)).toEqual(["x", "y", "x"]);
        const lone = await sql<{ n: number }[]>`select count(*)::int as n from generated`;
        expect(lone[0]?.n).toBe(3);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "tenancy fills the key and archivable rows stay active when rows differ",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(tenant.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: tenant, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT });
        const stored = await a.scoped.insert(
          [
            { title: "one" },
            { title: "two", prio: 9 },
            { title: "three", prio: undefined, note: null },
            { title: "four", note: "n" },
          ],
          { returning: ["title", "prio", "note", "tenantId"] },
        );
        expect(stored as unknown).toEqual([
          { title: "one", prio: 3, note: null, tenantId: TENANT },
          { title: "two", prio: 9, note: null, tenantId: TENANT },
          { title: "three", prio: 3, note: null, tenantId: TENANT },
          { title: "four", prio: 3, note: "n", tenantId: TENANT },
        ]);
        expect(await a.scoped.count({})).toBe(4);
        expect(await total(sql, "scoped where archived_at is null")).toBe(4);
        expect(await db.for({ tenantId: OTHER }).scoped.count({})).toBe(0);
        const archived = await a.scoped.archive({ where: { title: "two" } });
        expect(archived.count).toBe(1);
        expect(await a.scoped.count({})).toBe(3);
        expect(await a.scoped.withArchived().count({})).toBe(4);
        const ids = await sql<{ id: string }[]>`select id from scoped`;
        expect(new Set(ids.map((row) => row.id)).size).toBe(4);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "rows with different keys chunk across the parameter limit",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(plain.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: plain, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const count = Math.ceil(WRITE_PARAM_BUDGET * 1.5);
        const rows = Array.from({ length: count }, (_, idx) => {
          if (idx % 4 === 0) return { idx };
          if (idx % 4 === 1) return { idx, label: `l${String(idx)}`, score: idx };
          if (idx % 4 === 2) return { idx, score: undefined, note: `n${String(idx)}` };
          return { idx, flag: null, label: undefined };
        });
        const planned = await db.bulk.insert(rows).sql();
        expect(planned.statements.length).toBeGreaterThan(1);
        for (const statement of planned.statements) {
          expect(statement.params?.length ?? 0).toBeLessThanOrEqual(WRITE_PARAM_BUDGET);
        }
        expect(await db.bulk.insert(rows, { returning: ["idx"] })).toHaveLength(count);
        const stored = await sql<Stored[]>`${sql.unsafe(`${STORED} bulk order by idx`)}`;
        expect(stored).toHaveLength(count);
        for (const row of stored) {
          const kind = row.idx % 4;
          expect(row.label).toBe(kind === 1 ? `l${String(row.idx)}` : "x");
          expect(row.score).toBe(kind === 1 ? row.idx : 7);
          expect(row.note).toBe(kind === 2 ? `n${String(row.idx)}` : null);
          expect(row.flag).toBe(kind === 3 ? null : true);
        }
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "conflict handling and validation take rows with different keys",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(plain.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: plain, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.slots.insert([{ idx: 1 }, { idx: 2, label: "two" }, { idx: 3, score: 3 }]);
        await db.slots.insert([{ idx: 1, label: "never" }, { idx: 4, score: 4 }, { idx: 5 }], {
          onConflict: "ignore",
        });
        await db.slots.insert([{ idx: 2, label: "updated" }, { idx: 6 }, { idx: 7, score: 1 }], {
          onConflict: { on: "idx", update: ["label"] },
        });
        const returned = await db.slots.insert(
          [{ idx: 3 }, { idx: 8, label: "eight" }, { idx: 9 }],
          {
            onConflict: { on: "idx", return: true },
            returning: ["idx", "label", "score"],
          },
        );
        expect(returned.map((row) => row.idx)).toEqual([3, 8, 9]);
        expect(returned.map((row) => row.score)).toEqual([3, 7, 7]);
        const stored = await sql<{ idx: number; label: string; score: number }[]>`
          select idx, label, score from slots order by idx
        `;
        expect(stored.map((row) => [row.idx, row.label, row.score])).toEqual([
          [1, "x", 7],
          [2, "updated", 7],
          [3, "x", 3],
          [4, "x", 4],
          [5, "x", 7],
          [6, "x", 7],
          [7, "x", 1],
          [8, "eight", 7],
          [9, "x", 7],
        ]);

        // validation runs per row and leaves the omitted keys to the database
        const rows = await db.checked.insert(
          [{ title: "a" }, { title: "b", prio: 5 }, { title: "c", prio: undefined }],
          { returning: ["title", "prio"] },
        );
        expect(rows as unknown).toEqual([
          { title: "a", prio: 3 },
          { title: "b", prio: 5 },
          { title: "c", prio: 3 },
        ]);
        const bad = await db.checked.insert([{ title: "ok" }, { title: "", prio: 1 }]).safe();
        expect(bad.ok).toBe(false);
        expect(await total(sql, "checked")).toBe(3);
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

type Pick<T> =
  | { readonly tag: "absent" }
  | { readonly tag: "undefined" }
  | { readonly tag: "null" }
  | { readonly tag: "value"; readonly value: T };

function pick<T>(value: fc.Arbitrary<T>, nullable: boolean): fc.Arbitrary<Pick<T>> {
  const tags: fc.Arbitrary<Pick<T>>[] = [
    fc.constant({ tag: "absent" } as const),
    fc.constant({ tag: "undefined" } as const),
    value.map((item) => ({ tag: "value", value: item }) as const),
  ];
  if (nullable) tags.push(fc.constant({ tag: "null" } as const));
  return fc.oneof(...tags);
}

function keyed(row: Record<string, unknown>, key: string, chosen: Pick<unknown>): void {
  if (chosen.tag === "absent") return;
  row[key] = chosen.tag === "undefined" ? undefined : chosen.tag === "null" ? null : chosen.value;
}

postgresTest(
  gate,
  "a random array insert stores the same rows as inserting each row alone",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(plain.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: plain, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const rowArb = fc.record({
          label: pick(fc.constantFrom("a", "b c", "it's"), false),
          score: pick(fc.integer({ min: -5, max: 99 }), false),
          note: pick(fc.constantFrom("n", "", "x,y"), true),
          flag: pick(fc.boolean(), true),
        });
        await fc.assert(
          fc.asyncProperty(fc.array(rowArb, { minLength: 1, maxLength: 9 }), async (picks) => {
            await sql`truncate bulk, single`;
            const rows = picks.map((chosen, idx) => {
              const row: Record<string, unknown> = { idx };
              keyed(row, "label", chosen.label);
              keyed(row, "score", chosen.score);
              keyed(row, "note", chosen.note);
              keyed(row, "flag", chosen.flag);
              return row;
            });
            await db.bulk.insert(rows as never);
            for (const row of rows) await db.single.insert(row as never);
            const together = await sql<Stored[]>`${sql.unsafe(`${STORED} bulk order by idx`)}`;
            const alone = await sql<Stored[]>`${sql.unsafe(`${STORED} single order by idx`)}`;
            expect(Array.from(together)).toEqual(Array.from(alone));
            const model = picks.map((chosen, idx): Stored => {
              const given = <T>(item: Pick<T>, fallback: T | null): T | null =>
                item.tag === "value" ? item.value : item.tag === "null" ? null : fallback;
              return {
                idx,
                label: given(chosen.label, "x") ?? "x",
                score: given(chosen.score, 7) ?? 7,
                note: given(chosen.note, null),
                flag: given(chosen.flag, true),
              };
            });
            expect(Array.from(together)).toEqual(model);
          }),
          { numRuns: 40 },
        );
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
