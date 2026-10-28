/**
 * `minPostgres` and the deprecated `requires.postgres` string are one floor.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogHash, serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { UUIDV7_POSTGRES } from "../src/dialects/pg/floor.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { repoRoot } from "../scripts/root.js";

const notes = table("notes", { id: t.identity(), name: t.text() });
const sessions = table("sessions", { id: t.id({ default: "uuidv7" }), name: t.text() });
const bare = table("bare", { id: t.id(), name: t.text() });

test("minPostgres and the string form store the same floor and the same catalog", () => {
  const byNumber = schema({ minPostgres: 17, tables: [notes] });
  const byString = schema({ requires: { postgres: ">=17" }, tables: [notes] });
  expect(byNumber.requires).toEqual({ postgres: ">=17" });
  expect(byString.requires).toEqual(byNumber.requires);
  expect(serializeCatalog(byNumber.catalog)).toBe(serializeCatalog(byString.catalog));
  expect(catalogHash(byNumber.catalog)).toBe(catalogHash(byString.catalog));
  const higher = schema({ minPostgres: 18, tables: [notes] });
  expect(catalogHash(higher.catalog)).toBe(catalogHash(byNumber.catalog));
  expect(schema({ tables: [notes] }).requires).toBeUndefined();
});

test("a floor that is not an allowed major is OKM1060 and names minPostgres", () => {
  const bad = [
    { minPostgres: 19 },
    { minPostgres: 14 },
    { minPostgres: 13 },
    { minPostgres: 17.2 },
    { minPostgres: "17" },
    { minPostgres: 9 },
    { minPostgres: 0 },
    { requires: { postgres: ">= 17" } },
    { requires: { postgres: "17" } },
    { requires: { postgres: ">=17.2" } },
    { requires: { postgres: "" } },
    { requires: { postgres: ">=19" } },
    { requires: { postgres: ">=9" } },
    { requires: ">=17" },
  ];
  for (const input of bad) {
    const error = capture(() => build(input));
    expect(error.code).toBe("OKM1060");
    expect(error.message).toBe("minPostgres: 15-18.");
  }
  const both = capture(() =>
    schema({ minPostgres: 17, requires: { postgres: ">=17" }, tables: [notes] }),
  );
  expect(both.code).toBe("OKM1060");
  expect(both.message).toContain("minPostgres");
  expect(both.message).toContain("requires.postgres");
});

test("an explicit uuidv7 below 18 is refused for both forms", () => {
  for (const input of [{ minPostgres: 17 }, { requires: { postgres: ">=17" } }] as const) {
    const error = capture(() => schema({ ...input, tables: [sessions] }));
    expect(error.code).toBe("OKM1812");
    expect(error.message).toContain("PostgreSQL 18");
    expect(error.message).toContain("minPostgres");
    expect(error.fix?.summary).toContain("minPostgres: 18");
  }
  expect(() => schema({ minPostgres: 18, tables: [sessions] })).not.toThrow();
  expect(() => schema({ requires: { postgres: ">=18" }, tables: [sessions] })).not.toThrow();
  expect(() => schema({ tables: [sessions] })).not.toThrow();
  expect(() => schema({ minPostgres: 17, tables: [bare] })).not.toThrow();
  const column = schema({ tables: [bare] }).catalog.objects.find(
    (object) => object.kind === "column",
  );
  expect(column?.kind === "column" ? column.definition.defaultExpression : "").toBe(
    "gen_random_uuid()",
  );
});

test("uuidv7's floor is named in the refusal and on the minPostgres page", () => {
  const error = capture(() => build({ minPostgres: UUIDV7_POSTGRES - 1, tables: [sessions] }));
  expect(error.message).toContain(String(UUIDV7_POSTGRES));
  expect(error.message).toContain("minPostgres");
  const page = readFileSync(join(repoRoot(), "site/content/docs/schema/the-schema.mdx"), "utf8");
  expect(page).toContain("uuidv7");
  expect(page).toContain(`Needs PostgreSQL ${String(UUIDV7_POSTGRES)} or higher.`);
});

/**
 * Builds a schema from a floor the type may already reject.
 *
 * The cast is the runtime check. The type check lives in `min-postgres.test-d.ts`.
 *
 * @param floor - `minPostgres` or `requires` fields, or another shape
 */
function build(floor: unknown): void {
  const fields =
    typeof floor === "object" && floor !== null ? (floor as Record<string, unknown>) : {};
  const config = { tables: fields.tables ?? [notes], ...fields };
  schema(config as never);
}

function capture(run: () => void): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
