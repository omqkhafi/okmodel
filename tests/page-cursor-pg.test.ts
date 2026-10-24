/**
 * Primary-key cursors for hidden and sensitive `orderBy` (N-64).
 *
 * A value cursor stays in place when the order names neither. Real Postgres.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { integer, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const notes = table(
  "notes",
  {
    id: text().primaryKey(),
    title: text(),
    code: text().nullable().hidden({ filterable: true }),
    token: text().sensitive(),
  },
  { traits: [archivable()] },
);

const edges = table(
  "edges",
  {
    scope: text(),
    n: integer(),
    code: text().nullable().hidden({ filterable: true }),
  },
  { primaryKey: ["scope", "n"] },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes, edges],
});

const gate = await loadPostgresGate();

type Page = {
  readonly items: readonly { readonly id: string }[];
  readonly next: string | null;
};

type EdgePage = {
  readonly items: readonly { readonly scope: string; readonly n: number }[];
  readonly next: string | null;
};

function decodeCursor(token: string): unknown {
  const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function catchCode(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("expected OkmError");
}

async function ids(
  read: (after: string | null) => PromiseLike<Page>,
): Promise<{ readonly ids: string[]; readonly cursors: string[] }> {
  const seen: string[] = [];
  const cursors: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: Page = await read(after);
    seen.push(...page.items.map((item) => item.id));
    if (page.next === null) return { ids: seen, cursors };
    cursors.push(page.next);
    after = page.next;
  }
  throw new Error("page() did not end");
}

postgresTest(
  gate,
  "a hidden or sensitive order pages by primary key, and a plain order keeps value cursors",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.notes.insert([
          { id: "01", title: "t", code: "a", token: "secret-a" },
          { id: "02", title: "t", code: "a", token: "secret-b" },
          { id: "03", title: "m", code: null, token: "secret-c" },
          { id: "04", title: "u", code: "b", token: "secret-d" },
          { id: "05", title: "z", code: null, token: "secret-e" },
        ]);
        await b.notes.insert({ id: "b1", title: "b", code: "a", token: "secret-other" });

        const hidden = await ids((after) =>
          a.notes.page({ orderBy: { code: "asc" }, limit: 2, after }),
        );
        // Ties on "a", then "b", then nulls last, with the primary key breaking ties.
        expect(hidden.ids).toEqual(["01", "02", "04", "03", "05"]);
        expect(hidden.cursors).toHaveLength(2);
        for (const cursor of hidden.cursors) {
          const decoded = decodeCursor(cursor) as string[];
          expect(decoded[0]).toBe("k");
          expect(decoded[1]).toContain("code.asc.last");
          expect(JSON.stringify(decoded)).not.toContain("secret-");
          const values = decoded.slice(2);
          expect(values.some((value) => value === "a" || value === "b")).toBe(false);
        }
        // The primary key is (id, tenantId). The hidden sort value stays out.
        expect((decodeCursor(hidden.cursors[0] ?? "") as string[]).slice(2)).toEqual([
          "02",
          TENANT_A,
        ]);
        expect((decodeCursor(hidden.cursors[1] ?? "") as string[]).slice(2)).toEqual([
          "03",
          TENANT_A,
        ]);

        const nullsFirst = await ids((after) =>
          a.notes.page({
            orderBy: { code: { dir: "asc", nulls: "first" } },
            limit: 2,
            after,
          }),
        );
        expect(nullsFirst.ids).toEqual(["03", "05", "01", "02", "04"]);

        const descending = await ids((after) =>
          a.notes.page({ orderBy: { code: "desc" }, limit: 2, after }),
        );
        expect(descending.ids).toEqual(["03", "05", "04", "01", "02"]);

        const sensitive = await ids((after) =>
          a.notes.page({ orderBy: { token: "asc" }, limit: 2, after }),
        );
        expect(sensitive.ids).toEqual(["01", "02", "03", "04", "05"]);
        for (const cursor of sensitive.cursors) {
          const text = JSON.stringify(decodeCursor(cursor));
          expect(text).not.toContain("secret-");
          expect(cursor).not.toContain("secret-");
        }

        const mixed = await a.notes.page({
          orderBy: { title: "asc", token: "asc" },
          limit: 2,
        });
        expect(mixed.next).not.toBeNull();
        const mixedCursor = decodeCursor(mixed.next ?? "") as string[];
        expect(mixedCursor[0]).toBe("k");
        expect(mixedCursor.slice(2)).toEqual(["01", TENANT_A]);
        expect(JSON.stringify(mixedCursor)).not.toContain("secret-");
        expect(mixedCursor).not.toContain("m");

        const found = await a.notes.find({
          select: ["id"],
          orderBy: { title: "asc" },
          limit: 20,
        });
        const plain = await ids((after) =>
          a.notes.page({ select: ["id"], orderBy: { title: "asc" }, limit: 2, after }),
        );
        expect(plain.ids).toEqual(found.map((row) => row.id));
        const valueCursor = decodeCursor(plain.cursors[0] ?? "");
        expect(Array.isArray(valueCursor)).toBe(true);
        expect((valueCursor as string[])[0]).not.toBe("k");
        expect(valueCursor).toContain("t");

        const described = await a.notes
          .page({ orderBy: { code: "asc" }, limit: 2, after: hidden.cursors[0] })
          .sql();
        expect(described.text.startsWith("with c as (")).toBe(true);
        expect(described.text.includes(";")).toBe(false);
        expect(described.text).toContain("join c on true");
        expect(described.text).toContain('"archived_at" is null');
        expect(described.text).toContain('"tenant_id" = ');
        expect(described.text).not.toContain("secret-");
        expect(described.params).not.toContain("secret-b");
        expect(described.params).toContain("02");
        const plainSql = await a.notes
          .page({ orderBy: { title: "asc" }, limit: 2, after: plain.cursors[0] })
          .sql();
        expect(plainSql.text.startsWith("select ")).toBe(true);

        const signature = (decodeCursor(hidden.cursors[0] ?? "") as string[])[1] ?? "";
        const forged = await catchCode(
          a.notes.page({
            orderBy: { code: "asc" },
            limit: 2,
            after: encodeCursor(["k", signature, "missing", TENANT_A]),
          }),
        );
        expect(forged.code).toBe("OKM1130");
        expect(forged.message).toBe("The cursor is no longer valid.");
        expect(forged.message).not.toContain("missing");

        const foreign = await catchCode(
          a.notes.page({
            orderBy: { code: "asc" },
            limit: 2,
            after: encodeCursor(["k", signature, "b1", TENANT_B]),
          }),
        );
        expect(foreign.code).toBe("OKM1130");
        expect(foreign.message).toBe("The cursor is no longer valid.");

        const oracle = await catchCode(
          a.notes.page({
            orderBy: { code: "asc" },
            limit: 2,
            after: encodeCursor([signature, "a", "02"]),
          }),
        );
        expect(oracle.code).toBe("OKM1130");
        expect(oracle.message).toBe("after is not a cursor that page() returned.");

        await a.notes.archive({ where: { id: "02" } });
        const archived = await catchCode(
          a.notes.page({ orderBy: { code: "asc" }, limit: 2, after: hidden.cursors[0] }),
        );
        expect(archived.message).toBe("The cursor is no longer valid.");
        const wide = await a.notes.withArchived().page({
          orderBy: { code: "asc" },
          limit: 2,
          after: hidden.cursors[0],
        });
        expect(wide.items.map((item) => item.id)).toEqual(["04", "03"]);
        await a.notes.restore({ where: { id: "02" } });

        await a.notes.delete({ where: { id: "02" } });
        const deleted = await catchCode(
          a.notes.page({ orderBy: { code: "asc" }, limit: 2, after: hidden.cursors[0] }),
        );
        expect(deleted.code).toBe("OKM1130");
        expect(deleted.message).toBe("The cursor is no longer valid.");
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a composite primary key is the whole cursor tuple",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.edges.insert([
          { scope: "s", n: 1, code: "a" },
          { scope: "s", n: 2, code: "a" },
          { scope: "s", n: 3, code: null },
          { scope: "s", n: 4, code: "b" },
        ]);
        await b.edges.insert({ scope: "s", n: 9, code: "z" });

        const seen: string[] = [];
        const cursors: string[] = [];
        let after: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const page: EdgePage = await a.edges.page({ orderBy: { code: "asc" }, limit: 2, after });
          seen.push(...page.items.map((item) => `${item.scope}:${String(item.n)}`));
          if (page.next === null) break;
          cursors.push(page.next);
          after = page.next;
        }
        expect(seen).toEqual(["s:1", "s:2", "s:4", "s:3"]);
        const first = decodeCursor(cursors[0] ?? "") as string[];
        expect(first[0]).toBe("k");
        expect(first.slice(2)).toEqual(["s", "2", TENANT_A]);
        expect(first).not.toContain("a");
        expect(first).not.toContain("b");

        const signature = first[1] ?? "";
        const foreign = await catchCode(
          a.edges.page({
            orderBy: { code: "asc" },
            limit: 2,
            after: encodeCursor(["k", signature, "s", "9", TENANT_B]),
          }),
        );
        expect(foreign.code).toBe("OKM1130");
        expect(foreign.message).toBe("The cursor is no longer valid.");
        expect(foreign.message).not.toContain("9");
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);
