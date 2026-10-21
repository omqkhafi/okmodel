/**
 * Static raw() discovery, the lock file, and offline drift.
 */

import { expect, test } from "bun:test";

import { normaliseRawSql, rawStatementKey } from "../src/dialects/pg/raw-key.js";
import { OkmError } from "../src/contracts/error.js";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OkmError ? error.code : undefined;
  }
}
import {
  parseLock,
  renderLock,
  renderRawTypes,
  staleLockCodes,
} from "../src/tooling/describe/lock.js";
import { discoverRawCalls, listRawSources } from "../src/tooling/describe/scan.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const imported = 'import { raw } from "okmodel/pg";\n';

test("a static call is kept and the traps are not", () => {
  const text = [
    imported,
    'export const rows = raw(db, "select id from tasks where owner = $1", [owner]);',
    "const alias = q(db, `select 1`, []);",
    '// raw(db, "select 2", [])',
    '/* raw(db, "select 3", []) */',
    'const text = "raw(db, \\"select 4\\")";',
    'const tpl = `raw(db, "select 5")`;',
    'note("raw(db, \\"select 6\\")");',
    "const pattern = /raw\\(/;",
    'db.raw(db, "select 7", []);',
    "raw(db, sql, []);",
  ].join("\n");
  expect(() => discoverRawCalls([{ path: "src/app.ts", text }])).toThrow(OkmError);
  const safe = text.replace("raw(db, sql, []);", "");
  const calls = discoverRawCalls([
    {
      path: "src/app.ts",
      text: `${imported.replace("{ raw }", "{ raw as q }")}\nconst rows = q(db, "select id from tasks where owner = $1", [owner]);\n`,
    },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.exact).toBe("select id from tasks where owner = $1");
  expect(calls[0]?.kind).toBe("read");
  expect(calls[0]?.key).toBe(rawStatementKey(calls[0]?.exact ?? ""));
  expect(discoverRawCalls([{ path: "src/app.ts", text: safe }])).toHaveLength(1);
});

test("comments, strings, templates, and another call's argument are not statements", () => {
  const text = [
    imported,
    'const rows = raw(db, "select id\\r\\nfrom tasks", []);',
    '// raw(db, "select hidden", [])',
    'const s = "raw(db, \\"select hidden\\")";',
    'const t = `raw(db, "select hidden")`;',
    "log(raw);",
    'other("raw(");',
    "const re = /raw\\(db/;",
  ].join("\n");
  const calls = discoverRawCalls([{ path: "src/app.ts", text }]);
  expect(calls.map((call) => call.normalised)).toEqual(["select id\nfrom tasks"]);
  expect(calls[0]?.kind).toBe("read");
});

test("a template substitution and a non-import are refused or ignored", () => {
  expect(
    codeOf(() =>
      discoverRawCalls([
        {
          path: "src/app.ts",
          text: `${imported}raw(db, \`select \${id}\`, []);\n`,
        },
      ]),
    ),
  ).toBe("OKM1603");
  const foreign = discoverRawCalls([
    {
      path: "src/app.ts",
      text: 'import { raw } from "./sql";\nraw(db, "select 1", []);\n',
    },
  ]);
  expect(foreign).toEqual([]);
});

test("with is a write only when a write keyword is outside a string", () => {
  const read = discoverRawCalls([
    {
      path: "src/app.ts",
      text: `${imported}raw(db, "with s as (select 1) select * from s", []);\n`,
    },
  ]);
  const write = discoverRawCalls([
    {
      path: "src/app.ts",
      text: `${imported}raw(db, "with s as (select 1) insert into tasks select * from s", []);\n`,
    },
  ]);
  const quoted = discoverRawCalls([
    {
      path: "src/app.ts",
      text: `${imported}raw(db, "with s as (select 'insert') select * from s", []);\n`,
    },
  ]);
  expect(read[0]?.kind).toBe("read");
  expect(write[0]?.kind).toBe("write");
  expect(quoted[0]?.kind).toBe("read");
  expect(
    codeOf(() =>
      discoverRawCalls([{ path: "src/app.ts", text: `${imported}raw(db, "values (1)", []);\n` }]),
    ),
  ).toBe("OKM1602");
});

test("tsx text is not a call and an expression inside it is", () => {
  const text = [
    imported,
    "export function View() {",
    "  return (",
    "    <section>",
    '      raw(db, "select hidden", [])',
    '      {raw(db, "select id from tasks", [])}',
    "    </section>",
    "  );",
    "}",
  ].join("\n");
  const calls = discoverRawCalls([{ path: "src/view.tsx", text }]);
  expect(calls.map((call) => call.exact)).toEqual(["select id from tasks"]);
});

test("two literals with the same normalised text share one key", () => {
  const calls = discoverRawCalls([
    {
      path: "src/a.ts",
      text: `${imported}raw(db, "select 1", []);\nraw(db, "  select 1\\r\\n", []);\n`,
    },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.key).toBe(calls[1]?.key);
  expect(calls[0]?.exact).not.toBe(calls[1]?.exact);
});

test("the lock round-trips and the declaration is keyed by the exact literal", () => {
  const calls = discoverRawCalls([
    {
      path: "src/app.ts",
      text: `${imported}raw(db, "  select id from tasks", []);\n`,
    },
  ]);
  const call = calls[0];
  if (call === undefined) throw new Error("missing call");
  const lock = {
    version: 1 as const,
    dialect: "postgres" as const,
    catalogHash: "abc",
    statements: {
      [call.key]: {
        sql: call.normalised,
        kind: call.kind,
        params: [{ pgType: "uuid" }],
        columns: [
          { name: "id", pgType: "integer", nullable: false },
          { name: "mood", pgType: "mood", nullable: true, enumLabels: ["open", "closed"] },
        ],
      },
    },
  };
  const text = renderLock(lock);
  expect(text.endsWith("\n")).toBe(true);
  expect(parseLock(text)).toEqual(lock);
  const types = renderRawTypes(calls, lock, { bigint: "bigint" });
  expect(types).toContain(JSON.stringify(call.exact));
  expect(types).toContain("readonly params: readonly [string];");
  expect(types).toContain("readonly id: number;");
  expect(types).toContain('readonly mood: "open" | "closed" | null');
  expect(types).toContain('readonly kind: "read";');
  expect(staleLockCodes([call.key], [call.key, "other"])).toEqual(["OKM1605"]);
});

test("include globs skip node_modules, dist, and .okm", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-raw-scan-"));
  mkdirSync(join(cwd, "src", "nested"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(cwd, "dist"), { recursive: true });
  mkdirSync(join(cwd, ".okm"), { recursive: true });
  writeFileSync(join(cwd, "src", "app.ts"), "");
  writeFileSync(join(cwd, "src", "nested", "view.tsx"), "");
  writeFileSync(join(cwd, "src", "worker.mts"), "");
  writeFileSync(join(cwd, "node_modules", "pkg", "skip.ts"), "");
  writeFileSync(join(cwd, "dist", "skip.ts"), "");
  writeFileSync(join(cwd, ".okm", "raw.d.ts"), "");
  expect(listRawSources(cwd)).toEqual(["src/app.ts", "src/nested/view.tsx", "src/worker.mts"]);
});

test("the checked declaration is the jsonb, enum-array, and unmapped render", () => {
  const payload = "select payload, meta from tasks";
  const labels = "select labels from tasks where mood = any($1)";
  const area = "select area from tasks";
  const call = (exact: string) => ({
    file: "src/app.ts",
    line: 1,
    exact,
    normalised: normaliseRawSql(exact),
    key: rawStatementKey(exact),
    kind: "read" as const,
  });
  const calls = [call(payload), call(labels), call(area)];
  const lock = {
    version: 1 as const,
    dialect: "postgres" as const,
    catalogHash: "abc",
    statements: {
      [calls[0]?.key ?? ""]: {
        sql: calls[0]?.normalised ?? "",
        kind: "read" as const,
        params: [],
        columns: [
          { name: "payload", pgType: "jsonb", nullable: false },
          { name: "meta", pgType: "json", nullable: false },
        ],
      },
      [calls[1]?.key ?? ""]: {
        sql: calls[1]?.normalised ?? "",
        kind: "read" as const,
        params: [{ pgType: "mood[]", enumLabels: ["open", "closed"] }],
        columns: [
          {
            name: "labels",
            pgType: "mood[]",
            nullable: false,
            enumLabels: ["open", "closed"],
          },
        ],
      },
      [calls[2]?.key ?? ""]: {
        sql: calls[2]?.normalised ?? "",
        kind: "read" as const,
        params: [],
        columns: [{ name: "area", pgType: "box", nullable: false }],
      },
    },
  };
  expect(readFileSync(join(import.meta.dir, "fixtures/raw/raw-generated.d.ts"), "utf8")).toBe(
    renderRawTypes(calls, lock),
  );
});
