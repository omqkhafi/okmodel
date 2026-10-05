/**
 * Three registered codes that 0.2 never throws, and why that is correct (D183).
 *
 * - OKM1110, a feature needs a newer engine than `requires` allows. In 0.2 the one
 *   feature that depends on the engine is `uuidv7()`, and it fails as OKM1812 when
 *   the schema is built (and OKM1802 when the server is older than `requires`).
 *   Nothing is gated at the type level yet.
 * - OKM1191, a multi-statement read inside READ COMMITTED. Every 0.2 read is one
 *   statement (`snapshot-reads.test.ts`), so the single-statement plan always exists.
 * - OKM1702, unverifiable raw SQL on a tenant table. No public runtime path takes raw
 *   SQL (`raw-sql-paths.test.ts`).
 *
 * This test fails when one of them starts to be thrown, so whoever adds the throw also
 * writes its test and updates the spec text that says 0.2 does not reach it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { OkmError } from "../src/contracts/error.js";

/** Source files under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("OKM1110, OKM1191 and OKM1702 are registered and not thrown anywhere in src", () => {
  const found: string[] = [];
  for (const file of sources("src")) {
    if (file.endsWith("tooling/errors/registry.ts") || file.endsWith("contracts/error.ts"))
      continue;
    const content = readFileSync(file, "utf8");
    for (const code of ["OKM1110", "OKM1191", "OKM1702"]) {
      if (content.includes(`"${code}"`)) found.push(`${file}: ${code}`);
    }
  }
  expect(found).toEqual([]);
  const registry = readFileSync("src/tooling/errors/registry.ts", "utf8");
  for (const code of ["OKM1110", "OKM1191", "OKM1702"]) {
    expect(registry).toContain(`code: "${code}"`);
  }
});

test("the engine-dependent feature of 0.2 fails as OKM1812 at schema build, not OKM1110", () => {
  const users = table("users", { id: id(), name: text() });
  let caught: unknown;
  try {
    schema({ requires: { postgres: ">=17" }, tables: [users] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  expect((caught as OkmError).code).toBe("OKM1812");
  // A schema that declares 18 builds.
  expect(() => schema({ requires: { postgres: ">=18" }, tables: [users] })).not.toThrow();
});
