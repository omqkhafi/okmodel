/**
 * Regenerates `lib/hero-derived.json`: what okmodel really does for each hero
 * scenario.
 *
 * For every scenario this writes the base schema to a scratch project, runs the
 * real `okm generate init`, applies the scenario's edit, then runs the real
 * `okm generate` and `okm build`. It records the schema diff, the statements the
 * planner wrote with their class and locks, what the linter printed, and the
 * first change in `.okm/types.d.ts`. Nothing is typed by hand.
 * `hero-derived.site-test.ts` runs it again and fails when the checked-in file
 * differs.
 *
 *   bun site/scripts/hero-derived.ts          # print
 *   bun site/scripts/hero-derived.ts --write  # update lib/hero-derived.json
 *
 * The scratch project imports `src/` directly, so a stale `dist/` cannot skew it.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyEdits,
  HERO_BASE_SCHEMA,
  HERO_SCENARIOS,
  type HeroDerived,
  type HeroDerivedMigrate,
  type HeroDerivedQuery,
  type HeroDiffRow,
  type HeroFinding,
  type HeroMigrateSpec,
  type HeroRule,
  type HeroStep,
} from "../lib/hero";
import { HERO_QUERIES, type HeroQuerySpec } from "../lib/hero-queries";
import { repoRoot } from "../lib/repo";

/** Rows of context kept around a change in the schema diff. */
const CONTEXT = 2;
/** Changed type lines shown before the rest are counted. */
const TYPE_ROWS = 4;

/** Published specifier to source file, read from the package's own export map. */
function specifierMap(root: string): ReadonlyArray<readonly [string, string]> {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    exports: Record<string, { import?: string } | string>;
  };
  const out: Array<readonly [string, string]> = [];
  for (const [key, target] of Object.entries(manifest.exports)) {
    const file = typeof target === "string" ? target : target.import;
    if (key === "." || file === undefined || !file.startsWith("./dist/")) continue;
    out.push([`okmodel/${key.slice(2)}`, join(root, file.replace("./dist/", "src/").replace(/\.js$/, ".ts"))]);
  }
  return out;
}

/** Point a published specifier at the source file behind it. */
function fromSource(text: string, root: string): string {
  let out = text;
  for (const [specifier, path] of specifierMap(root)) out = out.replaceAll(`"${specifier}"`, `"${path}"`);
  return out;
}

/** Back to what a reader sees: the published specifier, not a scratch path. */
function toPublished(text: string, root: string): string {
  let out = text;
  for (const [specifier, path] of specifierMap(root)) out = out.replaceAll(path, specifier);
  return out;
}

/** Run the CLI. A non-zero exit is not an error here: the linter exits non-zero on a finding. */
function okm(
  root: string,
  cwd: string,
  args: readonly string[],
): { readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync(["bun", join(root, "src/tooling/cli.ts"), ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Every row of a line diff, by longest common subsequence. */
function lineDiff(before: readonly string[], after: readonly string[]): HeroDiffRow[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const rows: HeroDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ n: j + 1, mark: "ctx", text: before[i]! });
      i += 1;
      j += 1;
    } else if (i < before.length && (j === after.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      // On a tie the removal comes first, as in any diff.
      rows.push({ n: null, mark: "del", text: before[i]! });
      i += 1;
    } else {
      rows.push({ n: j + 1, mark: "add", text: after[j]! });
      j += 1;
    }
  }
  return rows;
}

/** Keep {@link CONTEXT} rows around each change and fold the rest. */
function withContext(rows: readonly HeroDiffRow[]): HeroDiffRow[] {
  const keep = rows.map((row) => row.mark !== "ctx");
  const near = keep.map((_, index) =>
    keep.some((changed, other) => changed && Math.abs(other - index) <= CONTEXT),
  );
  const out: HeroDiffRow[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (near[index]) {
      if (hidden > 0) out.push({ n: null, mark: "fold", text: `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` });
      hidden = 0;
      out.push(row);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) out.push({ n: null, mark: "fold", text: `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` });
  return out;
}

/** The first run of changed type lines, labelled by the interface it sits in. */
function typesChange(before: string, after: string): HeroDerivedMigrate["types"] {
  const rows = lineDiff(before.split("\n"), after.split("\n"));
  const changed = rows.filter((row) => row.mark !== "ctx");
  if (changed.length === 0) return null;
  let start = rows.findIndex((row) => row.mark !== "ctx");
  // `Rows` is the map of every table. When a new table lands, show the table's own interface.
  if (/^export interface Rows\b/.test(rows[start]!.text)) {
    const own = rows.findIndex((row, index) => index > start && /^export interface (?!Rows\b)\w+/.test(row.text));
    if (own > start) start = own;
  }
  let end = start;
  while (end < rows.length && rows[end]!.mark !== "ctx") end += 1;
  let label = "types";
  for (let index = start; index >= 0; index -= 1) {
    const found = /export interface (\w+)/.exec(rows[index]!.text);
    if (found !== null) {
      label = found[1]!;
      break;
    }
  }
  const run = rows.slice(start, end);
  return { label, rows: run.slice(0, TYPE_ROWS), more: changed.length - Math.min(run.length, TYPE_ROWS) };
}

/** Statements of a migration file: the header the file gives each, then the SQL. */
function parseMigration(sql: string): { class: "expand" | "contract"; steps: HeroStep[] } {
  const blocks = sql.trim().split(/\n\n+(?=-- )/);
  const head = blocks.shift() ?? "";
  const fileClass = /^-- class: (expand|contract)$/m.exec(head)?.[1];
  if (fileClass !== "expand" && fileClass !== "contract") throw new Error("migration has no class");
  const steps = blocks.map((block): HeroStep => {
    const lines = block.split("\n");
    const header = lines.filter((line) => line.startsWith("-- "));
    const read = (key: string): string | undefined =>
      header.find((line) => line.startsWith(`-- ${key}: `))?.slice(`-- ${key}: `.length);
    const stepClass = read("class");
    const kind = read("kind");
    const lock = read("lock");
    if ((stepClass !== "expand" && stepClass !== "contract") || kind === undefined || lock === undefined) {
      throw new Error(`migration step has no class, kind, or lock:\n${block}`);
    }
    return {
      class: stepClass,
      kind,
      lock,
      transactional: read("transactional") !== "false",
      sql: lines.filter((line) => !line.startsWith("-- ")).join("\n").trim(),
    };
  });
  return { class: fileClass, steps };
}

/** One linter line. It may sit after `error OKM1510:` on the same line. */
const FINDING_LINE = /(error|warning) (OKM\d+) step (\d+): (.*?) -- fix: (.*)$/;

/**
 * Findings `okm generate` printed.
 *
 * Warnings are lines on stdout. Error findings are inside the OKM1510 text
 * on stderr, and the first one shares that line (`error OKM1510: error OKM1528 step 1: ...`).
 *
 * @param stdout - What the command wrote to stdout
 * @param stderr - What the command wrote to stderr
 * @returns Findings from both, stdout first
 */
export function findingsFromCli(stdout: string, stderr: string): HeroFinding[] {
  const findings: HeroFinding[] = [];
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const found = FINDING_LINE.exec(line.trim());
    if (found === null) continue;
    findings.push({
      severity: found[1] as HeroFinding["severity"],
      code: found[2]!,
      step: Number(found[3]),
      message: found[4]!,
      fix: found[5]!,
    });
  }
  return findings;
}

function migrate(root: string, spec: HeroMigrateSpec): HeroDerivedMigrate {
  const base = spec.base ?? HERO_BASE_SCHEMA;
  const dir = mkdtempSync(join(tmpdir(), "okm-hero-"));
  try {
    mkdirSync(join(dir, "migrations"));
    writeFileSync(
      join(dir, "okmodel.config.ts"),
      fromSource(
        `import { defineConfig } from "okmodel/migrate";\nexport default defineConfig({ schema: "./schema.ts", database: "postgres://u:p@localhost:5432/db" });\n`,
        root,
      ),
    );
    writeFileSync(join(dir, "schema.ts"), fromSource(base, root));
    okm(root, dir, ["generate", "init"]);
    okm(root, dir, ["build"]);
    const typesBefore = readFileSync(join(dir, ".okm/types.d.ts"), "utf8");

    const edited = applyEdits(spec);
    writeFileSync(join(dir, "schema.ts"), fromSource(edited, root));
    const printed = okm(root, dir, ["generate", spec.name]);
    okm(root, dir, ["build"]);
    const typesAfter = readFileSync(join(dir, ".okm/types.d.ts"), "utf8");

    // `generate init` writes nothing for a schema with no tables, so the number is not fixed.
    const file = readdirSync(join(dir, "migrations")).find((name) => name.endsWith(`_${spec.name}.sql`));
    if (file === undefined) {
      throw new Error(
        `${spec.id}: okm generate wrote no ${spec.name} migration\n${printed.stdout}${printed.stderr}`,
      );
    }
    const migration = parseMigration(readFileSync(join(dir, "migrations", file), "utf8"));
    return {
      kind: "migrate",
      id: spec.id,
      diff: withContext(lineDiff(base.trimEnd().split("\n"), edited.trimEnd().split("\n"))),
      plan: { file: `migrations/${file}`, class: migration.class, steps: migration.steps },
      lint: findingsFromCli(toPublished(printed.stdout, root), toPublished(printed.stderr, root)),
      types: typesChange(typesBefore, typesAfter),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Break a statement before each top-level clause, so it reads in a panel. */
function formatSql(text: string): string {
  const clauses = /^(from|left join|inner join|join|where|group by|order by|limit|offset|on conflict|returning|values|having|union)\b/i;
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (
      depth === 0 &&
      ch === " " &&
      clauses.test(text.slice(i + 1)) &&
      !/(left|right|inner|cross|full)$/i.test(out)
    ) {
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** How many rows of a list a result shows. */
const RESULT_ROWS = 4;

/** A value on one line: `{ id: "1", name: "Ada" }`. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const plain = Object.getPrototypeOf(value) === Object.prototype;
    if (!plain) return JSON.stringify(String(value));
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([key, item]) => `${key}: ${inline(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** A returned value as text: a list one row a line, an object one key a line. */
function block(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const shown = value.slice(0, RESULT_ROWS).map((item) => `${indent}  ${inline(item)},`);
    if (value.length > RESULT_ROWS) shown.push(`${indent}  // ${value.length - RESULT_ROWS} more rows`);
    return `[\n${shown.join("\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    return `{\n${entries.map(([key, item]) => `${indent}  ${key}: ${block(item, `${indent}  `)},`).join("\n")}\n${indent}}`;
  }
  return inline(value);
}

/** Rows a call returned, when it returns a list or a page (`items`). */
function rowCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object" && "items" in value && Array.isArray(value.items)) {
    return value.items.length;
  }
  return null;
}

/** The query scenario's code as shown: the model lines, then the call. */
function queryCode(spec: HeroQuerySpec): HeroDiffRow[] {
  if (!spec.schema.includes(spec.model)) throw new Error(`${spec.id}: model is not a part of the schema`);
  const rows: HeroDiffRow[] = [];
  let n = 1;
  for (const text of spec.model.split("\n")) rows.push({ n: n++, mark: "ctx", text });
  rows.push({ n: n++, mark: "ctx", text: "" });
  for (const text of `const rows = await ${spec.expr};`.split("\n")) rows.push({ n: n++, mark: "hot", text });
  return rows;
}

function query(root: string, spec: HeroQuerySpec): HeroDerivedQuery {
  const dir = mkdtempSync(join(tmpdir(), "okm-hero-"));
  try {
    const driver = specifierMap(root).find(([specifier]) => specifier === "okmodel/pg/pglite")?.[1];
    const testing = specifierMap(root).find(([specifier]) => specifier === "okmodel/testing")?.[1];
    if (driver === undefined || testing === undefined) throw new Error("package exports lost pglite or testing");
    writeFileSync(
      join(dir, "run.ts"),
      `${fromSource(spec.schema, root)}
import { open } from "${driver}";
import { testing } from "${testing}";

const harness = await testing(app, { driver: open() });
const db = harness.db;
${fromSource(spec.seed, root)}
const call = ${spec.expr};
const sql = await call.sql();
const info = await call.inspect();
const result = await call;
console.log("@@" + JSON.stringify({ sql, rules: info.rules, result }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
await harness.close();
`,
    );
    const run = Bun.spawnSync(["bun", "run.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const line = run.stdout.toString().split("\n").find((item) => item.startsWith("@@"));
    if (line === undefined) throw new Error(`${spec.id}: the query did not run\n${run.stderr.toString()}`);
    const out = JSON.parse(line.slice(2)) as {
      sql: { text: string; params: unknown[] };
      rules: HeroRule[];
      result: unknown;
    };
    return {
      kind: "query",
      id: spec.id,
      code: queryCode(spec),
      sql: { text: formatSql(out.sql.text), params: out.sql.params.map((param) => String(param)) },
      result: { text: block(out.result, ""), count: rowCount(out.result) },
      rules: out.rules.map(({ rule, contribution, provenance }) => ({ rule, contribution, provenance })),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the real tooling on every hero scenario.
 */
export function generateHeroDerived(): { readonly scenarios: ReadonlyArray<HeroDerived> } {
  const root = repoRoot();
  return {
    scenarios: [
      ...HERO_SCENARIOS.map((spec) => migrate(root, spec)),
      ...HERO_QUERIES.map((spec) => query(root, spec)),
    ],
  };
}

if (import.meta.main) {
  const text = `${JSON.stringify(generateHeroDerived(), null, 2)}\n`;
  if (process.argv.includes("--write")) {
    writeFileSync(join(repoRoot(), "site/lib/hero-derived.json"), text);
    console.log("wrote site/lib/hero-derived.json");
  } else {
    process.stdout.write(text);
  }
}
