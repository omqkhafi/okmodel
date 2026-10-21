/**
 * An export is dead when nothing in src, tests, or scripts imports it
 * and it is not on the public surface.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deadExports, surfaceKey } from "../scripts/dead-exports.js";

test("the api-surface key is the package name plus the export subpath", () => {
  expect(surfaceKey("okmodel", ".")).toBe("okmodel");
  expect(surfaceKey("okmodel", "./pg")).toBe("okmodel/pg");
});

test("unused exports are reported and public or imported names are not", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-dead-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  mkdirSync(join(root, "packages", "extra"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  writeFileSync(
    join(root, "tests", "fixtures", "api-surface.json"),
    JSON.stringify({ fixture: [{ name: "Public", kind: "stable" }] }),
  );
  writeFileSync(
    join(root, "src", "index.ts"),
    'export { Public } from "./lib.js";\nexport const LocalOnly = 1;\n',
  );
  writeFileSync(
    join(root, "src", "lib.ts"),
    "export function Public() { return 1; }\nexport function unused() { return 2; }\nexport type Hidden = string;\n",
  );
  writeFileSync(
    join(root, "tests", "use.test.ts"),
    'import type { Hidden } from "../src/lib.js";\ntype Keep = Hidden;\n',
  );
  writeFileSync(
    join(root, "packages", "extra", "caller.ts"),
    'import { unused } from "../../src/lib.js";\nvoid unused;\n',
  );
  try {
    const found = deadExports(root);
    const names = found.map((exp) => `${exp.file} ${exp.name}`);
    expect(names).toContain("src/index.ts LocalOnly");
    expect(names).toContain("src/lib.ts unused");
    expect(names).not.toContain("src/lib.ts Public");
    expect(names).not.toContain("src/index.ts Public");
    expect(names).not.toContain("src/lib.ts Hidden");
    const unused = found.find((exp) => exp.name === "unused");
    expect(unused?.outside).toEqual(["packages/extra/caller.ts"]);
    expect(unused?.isType).toBe(false);
    const local = found.find((exp) => exp.name === "LocalOnly");
    expect(local?.outside).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
