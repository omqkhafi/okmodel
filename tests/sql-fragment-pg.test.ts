/**
 * Composed fragments on Postgres 17: nesting, a bound injection, and tenancy.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, ident, id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const NOTE_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const NOTE_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const PAYLOAD = "'; drop table notes; --";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
  status: text(),
  secret: text().hidden().nullable(),
  code: text().hidden({ filterable: true }).nullable(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

const gate = await loadPostgresGate();

postgresTest(gate, "a fragment keeps the tenant and binds the injection", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.notes.insert({ id: NOTE_A, title: "hello", status: "open", code: "k" });
      await b.notes.insert({ id: NOTE_B, title: PAYLOAD, status: "open" });
      const open = fragment`${ident("status")} = ${"open"}`;
      const rows = await a.notes.find({
        where: { title: fragment`length(${fragment.column}) > ${3} and ${open}` },
        select: ["id", fragment`length(${ident("title")})`.as("len")],
        limit: 5,
      });
      expect(rows.map((row) => row.id)).toEqual([NOTE_A]);
      expect(rows[0]?.len).toBe(5);
      const injected = await a.notes.find({
        where: { title: fragment`${ident("title")} = ${PAYLOAD}` },
        limit: 5,
      });
      expect(injected).toEqual([]);
      const other = await b.notes.find({
        where: { title: fragment`${ident("title")} = ${PAYLOAD}` },
        limit: 5,
      });
      expect(other.map((row) => row.id)).toEqual([NOTE_B]);
      const coded = await a.notes.find({
        where: { title: fragment`${ident("code")} = ${"k"}` },
        limit: 5,
      });
      expect(coded.map((row) => row.id)).toEqual([NOTE_A]);
      await expectHidden(
        a.notes.find({
          where: { title: fragment`${ident("secret")} = ${"x"}` },
          limit: 1,
        }),
      );
      await expectHidden(
        a.notes.find({
          select: ["id", fragment`length(${ident("secret")})`.as("len")],
          limit: 1,
        }),
      );
      await expectHidden(
        a.notes.find({
          select: ["id", fragment`length(${ident("code")})`.as("len")],
          limit: 1,
        }),
      );
      let unknown: unknown;
      try {
        await a.notes.find({
          where: { title: fragment`${ident("missing")} = ${"x"}` },
          limit: 1,
        });
      } catch (error) {
        unknown = error;
      }
      expect(unknown).toBeInstanceOf(OkmError);
      if (unknown instanceof OkmError) {
        expect(unknown.code).toBe("OKM1120");
        expect(unknown.fix.summary.length).toBeGreaterThan(0);
      }
    } finally {
      await db.close();
    }
  });
});

async function expectHidden(pending: PromiseLike<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1120");
      expect(error.message).toContain("is hidden.");
      expect(error.fix.summary.length).toBeGreaterThan(0);
    }
    return;
  }
  throw new Error("expected OKM1120");
}

function expectBackslash(build: () => unknown): void {
  expect(build).toThrow(OkmError);
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1125");
      expect(error.message).toBe("A fragment cannot include a backslash.");
      expect(error.fix.summary).toBe("Pass the value as an interpolation.");
    }
    return;
  }
  throw new Error("expected OKM1125");
}

function asTemplate(literal: string): TemplateStringsArray {
  return Object.assign([literal], { raw: [literal] }) as unknown as TemplateStringsArray;
}

postgresTest(gate, "a backslash cannot desync the fragment guard (B-01)", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.notes.insert({ id: NOTE_A, title: "hello", status: "open" });
      await b.notes.insert({ id: NOTE_B, title: "other", status: "open" });

      const leak = (): unknown =>
        fragment`${ident("title")} = E'\\'' ) or ( true or title = E'\\''`;
      expectBackslash(leak);
      let rows: unknown;
      try {
        rows = await a.notes.find({
          where: { title: leak() as never },
          limit: 5,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) {
          expect(error.code).toBe("OKM1125");
        }
        rows = "refused";
      }
      expect(rows).toBe("refused");

      expectBackslash(() => fragment`${ident("title")} = E'\\''`);
      expectBackslash(() => fragment`${ident("title")} = e'\\''`);
      expectBackslash(() => fragment`${ident("title")} = E'\\'\\''`);
      expectBackslash(() => fragment`${ident("title")} = E'\\'' ) or ( title = $$x$$`);
      expectBackslash(() => fragment`${ident("title")} = '\\x27'`);

      await sql.unsafe("set standard_conforming_strings to off");
      expectBackslash(() => fragment`${ident("title")} = '\\''`);
      await sql.unsafe("set standard_conforming_strings to on");

      const doubled = await a.notes.find({
        where: { title: fragment`${ident("title")} = 'hel''lo'` },
        limit: 5,
      });
      expect(doubled).toEqual([]);
      await a.notes.update({
        where: { id: NOTE_A },
        set: { title: "hel'lo" },
      });
      const found = await a.notes.find({
        where: { title: fragment`${ident("title")} = 'hel''lo'` },
        limit: 5,
      });
      expect(found.map((row) => row.id)).toEqual([NOTE_A]);

      const unicode = await a.notes.find({
        where: {
          title: fragment`${ident("title")} = U&'!0068!0065!006C!0027!006C!006F' UESCAPE '!'`,
        },
        limit: 5,
      });
      expect(unicode.map((row) => row.id)).toEqual([NOTE_A]);

      const inside = await a.notes.find({
        where: {
          title: fragment`${ident("title")} = '--' or ${ident("title")} = '/*' or ${ident("title")} = '$x$' or ${ident("title")} = ';'`,
        },
        limit: 5,
      });
      expect(inside).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

postgresTest(
  gate,
  "accepted fragment literals match Postgres quote boundaries (B-01 fuzz)",
  async () => {
    await withPostgresSchema(async (sql) => {
      const alphabet = [`'`, `"`, "\\", "E", "e", "U", "&", "$", ";", "-", "/", "*", "(", ")"];
      expect(alphabet).toHaveLength(14);
      expect(alphabet).toContain("\\");
      const accepted: string[] = [];
      const samples: string[] = [];
      for (let length = 1; length <= 3; length += 1) {
        let batch = [""];
        for (let step = 0; step < length; step += 1) {
          const next: string[] = [];
          for (const prefix of batch) {
            for (const char of alphabet) next.push(prefix + char);
          }
          batch = next;
        }
        samples.push(...batch);
      }
      for (const sample of samples) {
        try {
          fragment(asTemplate(sample));
          accepted.push(sample);
        } catch (error) {
          expect(error).toBeInstanceOf(OkmError);
          if (error instanceof OkmError) expect(error.code).toBe("OKM1125");
        }
      }
      expect(samples.length).toBe(14 + 14 ** 2 + 14 ** 3);
      expect(accepted.length).toBeGreaterThan(0);
      for (const sample of accepted) {
        expect(sample.includes("\\")).toBe(false);
        try {
          await sql.unsafe(`select (${sample})`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message.toLowerCase()).not.toContain("unterminated");
        }
      }
    });
  },
  60_000,
);
