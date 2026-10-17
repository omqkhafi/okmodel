/**
 * Extension packs without a server.
 *
 * Version gates, the plan tail, the catalog hash, and the scaffold text.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { btreeGin } from "../src/dialects/pg/ext/btree-gin.js";
import { btreeGist } from "../src/dialects/pg/ext/btree-gist.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { fuzzystrmatch } from "../src/dialects/pg/ext/fuzzystrmatch.js";
import { hstore } from "../src/dialects/pg/ext/hstore.js";
import { pgcrypto } from "../src/dialects/pg/ext/pgcrypto.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { extScaffold } from "../src/tooling/migrate/ext.js";
import { renderScaffold, surfaceMismatches } from "../src/tooling/migrate/ext-surface.js";
import type { ServerSurface } from "../src/tooling/migrate/ext-surface.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

test("a pin below a feature is OKM1812 and names minPostgres", () => {
  const low = fuzzystrmatch({ version: "1.1" });
  const error = catchError(() => low.daitchMokotoff("a"));
  expect(error.code).toBe("OKM1812");
  expect(error.message).toContain("daitch_mokotoff");
  expect(error.message).toContain("minPostgres: 16");
  expect(() => fuzzystrmatch({ version: ">=1.2" }).daitchMokotoff("a")).not.toThrow();
  expect(() => fuzzystrmatch().daitchMokotoff("a")).not.toThrow();
  const crypto = pgcrypto({ version: "1.3" });
  const fips = catchError(() => crypto.fipsMode());
  expect(fips.code).toBe("OKM1812");
  expect(fips.message).toContain("minPostgres: 18");
});

test("btree_gist and btree_gin plans store the operator class", () => {
  const gist = btreeGist();
  const gin = btreeGin();
  const app = schema({
    tables: [
      table(
        "nums",
        { n: t.integer(), m: t.integer() },
        { indexes: (column) => [gist.gist(column.n.name), gin.gin(column.m.name)] },
      ),
    ],
    extensions: [gist, gin],
  });
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "idx" });
  const text = plan.steps.map((step) => step.sql).join("\n");
  expect(text).toContain('create extension "btree_gist"');
  expect(text).toContain('create extension "btree_gin"');
  expect(text).toContain('using gist ("n" gist_int4_ops)');
  expect(text).toContain('using gin ("m" int4_ops)');
});

test("provides and requires are not part of the catalog hash", () => {
  const plain = schema({
    tables: [table("notes", { title: t.text() })],
    extensions: [extension("hstore")],
  });
  const rich = schema({
    tables: [table("notes", { title: t.text() })],
    extensions: [
      extension("hstore", {
        requires: { postgres: ">=15", version: ">=1.8" },
        provides: { types: [{ name: "hstore" }] },
      }),
    ],
  });
  expect(catalogHash(rich.catalog)).toBe(catalogHash(plain.catalog));
});

test("scaffold text names types, operators, and functions", () => {
  const text = renderScaffold(sample());
  expect(text).toContain('extension("hstore"');
  expect(text).toContain('"name": "hstore"');
  expect(text).toContain('"name": "?"');
  expect(text).toContain('"name": "akeys"');
  expect(text).toContain("gin_hstore_ops");
  expect(text).toContain('">=1.8"');
});

test("scaffold text includes a composite type", () => {
  const text = renderScaffold({
    ...sample(),
    types: [{ name: "hstore" }, { name: "hstore_pair" }],
  });
  expect(text).toContain('"name": "hstore_pair"');
});

test("a wrong function signature is listed", () => {
  const declared = extension("hstore", {
    provides: { functions: [{ name: "akeys", args: ["text"], returns: "text[]" }] },
  });
  const lines = surfaceMismatches(declared, sample());
  expect(lines.join("\n")).toContain("akeys(text)");
});

test("hstore hasKey is a fragment and the plan creates the extension", () => {
  const pack = hstore();
  const app = schema({
    tables: [table("docs", { body: t.text() })],
    extensions: [pack],
  });
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "hstore" });
  expect(plan.steps.map((step) => step.sql).join("\n")).toContain('create extension "hstore"');
  expect(pack.hasKey("a")).toHaveProperty("as");
});

test("scaffold does not overwrite", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-ext-out-"));
  writeFileSync(join(cwd, "hstore.ts"), "export const keep = 1;\n");
  const error = await catchAsync(() =>
    extScaffold(cwd, "hstore", { allowProtected: false, allowPooler: false }, "hstore.ts"),
  );
  expect(error.code).toBe("invalid");
  expect(error.message).toContain("overwrite");
});

function sample(): ServerSurface {
  return {
    name: "hstore",
    version: "1.8",
    schema: "public",
    relocatable: true,
    serverMajor: 17,
    types: [{ name: "hstore" }],
    operators: [{ name: "?", left: "hstore", right: "text", result: "boolean" }],
    functions: [{ name: "akeys", args: ["hstore"], returns: "text[]" }],
    indexMethods: [{ name: "gin", opclass: "gin_hstore_ops" }],
    settings: [],
  };
}

function catchError(body: () => unknown): OkmError {
  try {
    body();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}

async function catchAsync(body: () => Promise<unknown>): Promise<OkmError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}
