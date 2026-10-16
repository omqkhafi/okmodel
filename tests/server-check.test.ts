/**
 * Startup query text for `public` and for a placed catalog namespace.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import {
  historySql,
  recordedNamespace,
  versionQuery,
  versionSql,
} from "../src/runtime/server-check.js";
import { buildProject } from "../src/tooling/migrate/project.js";
import { repoRoot } from "../scripts/root.js";

const PUBLIC_QUERY =
  "select current_setting('server_version_num'), version(), (select (xpath('//catalog_hash/text()', query_to_xml('select catalog_hash from okm_meta where id = ''head''', true, false, '')))[1]::text where to_regclass('okm_meta') is not null)";

const PUBLIC_HISTORY =
  "select migration_id, class, catalog_hash from okm_history order by migration_id, step_index";

test("public keeps the unqualified startup query", async () => {
  expect(versionQuery).toBe(PUBLIC_QUERY);
  expect(await versionSql("public")).toBe(versionQuery);
  expect(await historySql("public")).toBe(PUBLIC_HISTORY);
  const empty = mkdtempSync(join(tmpdir(), "okm-ns-"));
  expect(await recordedNamespace(empty)).toBe("public");
  writeFileSync(join(empty, "namespace"), "public\n");
  expect(await recordedNamespace(empty)).toBe("public");
  rmSync(empty, { recursive: true, force: true });
});

test("a placed namespace qualifies okm_meta and okm_history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-ns-"));
  writeFileSync(join(dir, "namespace"), "billing\n");
  expect(await recordedNamespace(dir)).toBe("billing");
  const version = await versionSql("billing");
  expect(version).toContain(`to_regclass('"billing".okm_meta')`);
  expect(version).toContain(`select catalog_hash from "billing".okm_meta where id = ''head''`);
  expect(version).not.toBe(versionQuery);
  expect(await historySql("billing")).toBe(
    `select migration_id, class, catalog_hash from "billing".okm_history order by migration_id, step_index`,
  );
  expect(await historySql('a"b')).toBe(
    `select migration_id, class, catalog_hash from "a""b".okm_history order by migration_id, step_index`,
  );
  writeFileSync(join(dir, "namespace"), "bill\ning\n");
  const broken = await recordedNamespace(dir).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(broken).toBeInstanceOf(OkmError);
  if (broken instanceof OkmError) expect(broken.code).toBe("OKM1122");
  rmSync(dir, { recursive: true, force: true });
});

test("okm build writes .okm/namespace only for a non-public catalog", async () => {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-build-ns-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'export const notes = table("notes", { id: t.integer() });',
        "export default schema({ tables: [notes] });",
        "",
      ].join("\n"),
    );
    writeConfig(cwd, "billing");
    await buildProject(cwd);
    expect(readFileSync(join(cwd, ".okm", "namespace"), "utf8")).toBe("billing\n");
    const pub = mkdtempSync(join(tmpdir(), "okm-build-pub-"));
    writeFileSync(join(pub, "schema.ts"), readFileSync(join(cwd, "schema.ts")));
    writeConfig(pub, undefined);
    await buildProject(pub);
    expect(existsSync(join(pub, ".okm", "namespace"))).toBe(false);
    writeFileSync(join(pub, ".okm", "namespace"), "billing\n");
    await Bun.sleep(2);
    await buildProject(pub);
    expect(existsSync(join(pub, ".okm", "namespace"))).toBe(false);
    rmSync(pub, { recursive: true, force: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeConfig(cwd: string, namespace: string | undefined): void {
  const migrate = JSON.stringify(join(repoRoot(), "src/tooling/migrate/index.ts"));
  const line = namespace === undefined ? "" : `  namespace: ${JSON.stringify(namespace)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      line.trimEnd(),
      "});",
      "",
    ]
      .filter((item) => item.length > 0)
      .join("\n"),
  );
}
