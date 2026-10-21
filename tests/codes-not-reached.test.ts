/**
 * Two registered codes that are not thrown, and why that is correct (D183).
 *
 * - OKM1110, a feature needs a newer engine than `requires` allows. The one
 *   feature that depends on the engine is an explicit `uuidv7()` database
 *   default, and it fails as OKM1812 when the schema is built (and OKM1802
 *   when the server is older than `requires`). A bare `t.id()` stores
 *   `gen_random_uuid()`. Nothing is gated at the type level yet.
 * - OKM1191, a multi-statement read inside READ COMMITTED. Every read is one
 *   statement (`snapshot-reads.test.ts`), so the single-statement plan always exists.
 *
 * OKM1702 is thrown: a raw write on a scoped tenant table, and a raw read that
 * does not select the primary key with `ident` (`ops/lane.ts`, D268).
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

test("OKM1110 and OKM1191 are registered and not thrown anywhere in src", () => {
  const found: string[] = [];
  for (const file of sources("src")) {
    // examples.ts lists codes that have no raising path. It does not throw them.
    if (
      file.endsWith("tooling/errors/registry.ts") ||
      file.endsWith("tooling/errors/examples.ts") ||
      file.endsWith("contracts/error.ts")
    ) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    for (const code of ["OKM1110", "OKM1191"]) {
      if (content.includes(`"${code}"`)) found.push(`${file}: ${code}`);
    }
  }
  expect(found).toEqual([]);
  const registry = readFileSync("src/tooling/errors/registry.ts", "utf8");
  for (const code of ["OKM1110", "OKM1191", "OKM1702"]) {
    expect(registry).toContain(`code: "${code}"`);
  }
});

test("an explicit uuidv7() fails as OKM1812 at schema build, not OKM1110", () => {
  const users = table("users", { id: id({ default: "uuidv7" }), name: text() });
  let caught: unknown;
  try {
    schema({ requires: { postgres: ">=17" }, tables: [users] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  expect((caught as OkmError).code).toBe("OKM1812");
  expect(() =>
    schema({
      requires: { postgres: ">=17" },
      tables: [table("users", { id: id(), name: text() })],
    }),
  ).not.toThrow();
  expect(() => schema({ requires: { postgres: ">=18" }, tables: [users] })).not.toThrow();
});
