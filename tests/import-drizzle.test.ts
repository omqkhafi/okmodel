/**
 * `okm import drizzle`: a PGlite round trip, refusals, and stable bytes (D280).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { OkmError } from "../src/contracts/error.js";
import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { run } from "../src/tooling/migrate/commands.js";
import { importDrizzle } from "../src/tooling/migrate/import-drizzle.js";
import { repoRoot } from "../scripts/root.js";
import { fixturePath, roundTrip } from "./import-drizzle-roundtrip.js";

const root = repoRoot();

test("import drizzle round-trips through PGlite", async () => {
  await roundTrip(async (statements) => {
    const db = new PGlite();
    try {
      await db.exec("create schema shop");
      await db.exec("set search_path to shop");
      for (const statement of statements) {
        if (statement.trim().length === 0) continue;
        await db.exec(statement);
      }
      return await introspectSchema(
        {
          async query(text, params) {
            const result = await db.query<Record<string, unknown>>(
              text,
              params === undefined ? [] : [...params],
            );
            return result.rows;
          },
        },
        "shop",
        "public",
      );
    } finally {
      await db.close();
    }
  });
}, 60_000);

test("import drizzle is deterministic and refuses an existing file", async () => {
  const cwd = mkdtempSync(join(root, ".okm-import-"));
  try {
    const first = await importDrizzle(cwd, [fixturePath, "--out", "one"]);
    const second = await importDrizzle(cwd, [fixturePath, "--out", "two"]);
    expect(tree(join(cwd, "one"))).toEqual(tree(join(cwd, "two")));
    expect(first.text).toBe(second.text);
    let refused: unknown;
    try {
      await importDrizzle(cwd, [fixturePath, "--out", "one"]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(OkmError);
    if (refused instanceof OkmError) expect(refused.code).toBe("OKM1855");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("import drizzle refuses a missing package, a missing file, and a directory", async () => {
  const empty = mkdtempSync(join(tmpdir(), "okm-drizzle-"));
  const cwd = mkdtempSync(join(root, ".okm-import-"));
  try {
    writeFileSync(join(empty, "schema.ts"), "export const name = 1;\n");
    expect((await refusal(importDrizzle(empty, ["schema.ts"]))).code).toBe("OKM1856");
    expect(await refusal(importDrizzle(cwd, [join(cwd, "missing.ts")]))).toBeInstanceOf(OkmError);
    expect(await refusal(importDrizzle(cwd, [cwd]))).toBeInstanceOf(OkmError);
    let help = "";
    await run(["import", "drizzle", "--help"], {
      cwd,
      stdout(text) {
        help += text;
      },
    });
    expect(help).toContain("runs that file");
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function refusal(task: Promise<unknown>): Promise<OkmError> {
  try {
    await task;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("the command should have refused");
}

function tree(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else out[path.slice(directory.length)] = readFileSync(path, "utf8");
    }
  };
  walk(directory);
  return out;
}
