/**
 * Pull, generate, and check agree, including `NOT ENFORCED` (D327).
 *
 * A check expression is the catalog expression, not a slice of
 * `pg_get_constraintdef`. Generate seals through the same reprint as check,
 * so a server normalisation is not a migration. Each case follows the major
 * of the server the suite is running on.
 */

import { expect } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { run } from "../src/tooling/migrate/commands.js";
import { pullProject } from "../src/tooling/migrate/pull.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
const ext = JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

const ENFORCED = `schema({
  tables: [table("qa_open", {
    n: t.integer(),
  }, {
    checks: { positive: (columns) => sql\`\${columns.n} > 0\` },
  })],
})`;

const NOT_ENFORCED = `schema({
  minPostgres: 18,
  tables: [table("qa_open", {
    n: t.integer(),
  }, {
    checks: {
      draft_ok: { expression: (columns) => sql\`\${columns.n} > 0\`, enforced: false },
    },
  })],
})`;

const STOP_ENFORCING = `schema({
  minPostgres: 18,
  tables: [table("qa_open", {
    n: t.integer(),
  }, {
    checks: {
      positive: { expression: (columns) => sql\`\${columns.n} > 0\`, enforced: false },
    },
  })],
})`;

const PICKLIST = `schema({
  tables: [table("doc", {
    id: t.uuid().defaultSql("gen_random_uuid()"),
    title: t.text(),
    kind: t.text().picklist(["open", "done"]),
    search: t.tsvector().generated((c) => sql\`to_tsvector('simple', \${c.title})\`),
  })],
})`;

const UUIDV7 = `schema({
  minPostgres: 18,
  tables: [table("doc", {
    id: t.uuid().defaultSql("uuidv7()"),
    title: t.text(),
  })],
})`;

const TOO_LOW = `schema({
  minPostgres: 17,
  tables: [table("qa_open", {
    n: t.integer(),
  }, {
    checks: {
      draft_ok: { expression: (columns) => sql\`\${columns.n} > 0\`, enforced: false },
    },
  })],
})`;

postgresTest(
  gate,
  "an enforced check round-trips and a later generate emits nothing",
  async () => {
    await roundTrip(ENFORCED);
  },
  60_000,
);

postgresTest(
  gate,
  "a NOT ENFORCED check round-trips on 18 and 19 and never validates",
  async () => {
    await roundTrip(NOT_ENFORCED, {
      when: (major) => major >= 18,
      assertSql: (sqlText) => {
        expect(sqlText.toLowerCase()).toContain("not enforced");
        expect(sqlText.toLowerCase()).not.toContain("validate");
      },
    });
  },
  60_000,
);

postgresTest(
  gate,
  "changing enforcement uses ALTER CONSTRAINT on 19 and a commented drop on 18",
  async () => {
    await inProject(ENFORCED, async ({ cwd, major, url }) => {
      if (major < 18) return;
      await run(["generate"], { cwd, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      // A second project. `run` keeps the first config module for the life of the process.
      const next = tempProject();
      try {
        writeConfig(next, url);
        writeSchema(next, STOP_ENFORCING);
        copyTree(join(cwd, "migrations"), join(next, "migrations"));
        const before = migrationSql(next);
        await run(["generate"], { cwd: next, stdout: () => undefined });
        const added = migrationSql(next).filter((file) => !before.includes(file));
        expect(added.length).toBe(1);
        const sqlText = readFileSync(join(next, "migrations", added[0] ?? ""), "utf8");
        expect(sqlText.toLowerCase()).not.toContain("validate");
        if (major >= 19) {
          expect(sqlText.toLowerCase()).toContain("alter constraint");
          expect(sqlText.toLowerCase()).toContain("not enforced");
        } else {
          expect(sqlText).toContain(
            "PostgreSQL 18 cannot ALTER CONSTRAINT enforcement, so this drops the check and adds it again.",
          );
          expect(sqlText.toLowerCase()).toContain("drop constraint");
          expect(sqlText.toLowerCase()).toContain("not enforced");
        }
        await run(["migrate", "apply"], { cwd: next, stdout: () => undefined });
        await run(["check"], { cwd: next, stdout: () => undefined });
        expect(migrationSql(next)).toEqual([...before, ...added]);
        await run(["generate"], { cwd: next, stdout: () => undefined });
        expect(migrationSql(next)).toEqual([...before, ...added]);
      } finally {
        rmSync(next, { recursive: true, force: true });
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a NOT VALID check pulls as a plain check and round-trips",
  async () => {
    await fromSql(
      [
        "create table qa_nv (n integer)",
        "alter table qa_nv add constraint qa_nv_n_check check (n > 0) not valid",
      ],
      (tree) => {
        const text = Object.values(tree).join("\n");
        expect(text).not.toContain("NOT VALID");
        expect(text).toContain("n > 0");
      },
    );
  },
  60_000,
);

postgresTest(
  gate,
  "a picklist and a generated tsvector stay clean in check and generate after pull",
  async () => {
    await agree(PICKLIST);
  },
  60_000,
);

postgresTest(
  gate,
  "a uuidv7() default round-trips on 18 and later",
  async () => {
    await roundTrip(UUIDV7, { when: (major) => major >= 18 });
  },
  60_000,
);

postgresTest(
  gate,
  "two checks on one column keep their own names when those names do not end in _check",
  async () => {
    await fromSql(
      [
        "create table qa_two (n integer)",
        "alter table qa_two add constraint chk_low check (n > 0)",
        "alter table qa_two add constraint chk_high check (n < 10)",
      ],
      (tree) => {
        const text = Object.values(tree).join("\n");
        expect(text).toContain("chk_low");
        expect(text).toContain("chk_high");
      },
    );
  },
  60_000,
);

postgresTest(gate, "a NO INHERIT check is refused", async () => {
  const database = await createIsolatedDatabase();
  const cwd = tempProject();
  try {
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create table qa_inh (n integer)");
      await sql.unsafe("alter table qa_inh add constraint qa_inh_n_check check (n > 0) no inherit");
    } finally {
      await sql.end({ timeout: 5 });
    }
    writeConfig(cwd, database.url);
    const error = await refusal(pullProject(cwd, ["--out", "pulled"]));
    expect(error.code).toBe("OKM1020");
    expect(error.message).toContain("NO INHERIT");
    expect(error.message).toContain("cannot represent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "enforced: false with minPostgres 17 is refused", async () => {
  const database = await createIsolatedDatabase();
  const cwd = tempProject();
  try {
    writeConfig(cwd, database.url);
    writeSchema(cwd, TOO_LOW);
    const error = await refusal(run(["generate"], { cwd, stdout: () => undefined }));
    expect(error.code).toBe("OKM1812");
    expect(error.message).toContain("minPostgres: 18");
    expect(error.message).toContain("enforced: false");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(
  gate,
  "pull does not write okmodel internal tables",
  async () => {
    await inProject(ENFORCED, async ({ cwd }) => {
      await run(["generate"], { cwd, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      await pullProject(cwd, ["--out", "pulled"]);
      const tree = readTree(join(cwd, "pulled"));
      for (const path of Object.keys(tree)) {
        expect(path).not.toContain("okm_");
      }
      expect(Object.values(tree).join("\n")).not.toContain("okm_meta");
    });
  },
  60_000,
);

type RoundOptions = {
  readonly when?: (major: number) => boolean;
  readonly assertSql?: (sqlText: string) => void;
};

/** Apply `source`, pull it, and apply that pull on an empty database. */
async function roundTrip(source: string, options?: RoundOptions): Promise<void> {
  await inProject(source, async ({ cwd, major }) => {
    if (options?.when !== undefined && !options.when(major)) return;
    await run(["generate"], { cwd, stdout: () => undefined });
    const created = readFileSync(join(cwd, "migrations", migrationSql(cwd)[0] ?? ""), "utf8");
    options?.assertSql?.(created);
    await run(["migrate", "apply"], { cwd, stdout: () => undefined });
    await run(["check"], { cwd, stdout: () => undefined });
    await pullProject(cwd, ["--out", "pulled"]);
    const empty = await createIsolatedDatabase();
    const next = tempProject();
    try {
      writeConfig(next, empty.url, "./pulled/schema.ts");
      copyTree(join(cwd, "pulled"), join(next, "pulled"));
      await run(["generate"], { cwd: next, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd: next, stdout: () => undefined });
      await run(["check"], { cwd: next, stdout: () => undefined });
      const files = migrationSql(next);
      await run(["generate"], { cwd: next, stdout: () => undefined });
      expect(migrationSql(next)).toEqual(files);
    } finally {
      rmSync(next, { recursive: true, force: true });
      await empty.close();
    }
  });
}

/**
 * Apply `source`, point the project at the pull, and require check and
 * generate to agree: both clean, then both see an added column.
 */
async function agree(source: string): Promise<void> {
  await inProject(source, async ({ cwd, url }) => {
    await run(["generate"], { cwd, stdout: () => undefined });
    await run(["migrate", "apply"], { cwd, stdout: () => undefined });
    await pullProject(cwd, ["--out", "pulled"]);
    const next = adopt(url, cwd);
    try {
      await run(["check"], { cwd: next, stdout: () => undefined });
      const files = migrationSql(next);
      await run(["generate"], { cwd: next, stdout: () => undefined });
      expect(migrationSql(next)).toEqual(files);
    } finally {
      rmSync(next, { recursive: true, force: true });
    }
    const drift = adopt(url, cwd);
    try {
      const schemaFile = join(drift, "pulled", "tables", "doc.ts");
      const text = readFileSync(schemaFile, "utf8");
      writeFileSync(
        schemaFile,
        text.replace("title: t.text()", "title: t.text(),\n    extra: t.integer().nullable()"),
      );
      const drifted = await refusal(run(["check"], { cwd: drift, stdout: () => undefined }));
      expect(drifted.code).toBe("OKM1520");
      const files = migrationSql(drift);
      await run(["generate"], { cwd: drift, stdout: () => undefined });
      expect(migrationSql(drift).length).toBe(files.length + 1);
    } finally {
      rmSync(drift, { recursive: true, force: true });
    }
  });
}

/** A new project whose schema is `cwd`'s pull and whose history is `cwd`'s. */
function adopt(url: string, cwd: string): string {
  const next = tempProject();
  writeConfig(next, url, "./pulled/schema.ts");
  copyTree(join(cwd, "pulled"), join(next, "pulled"));
  copyTree(join(cwd, "migrations"), join(next, "migrations"));
  return next;
}

/** Pull raw SQL, then apply that pull on an empty database. */
async function fromSql(
  statements: readonly string[],
  assertPull: (tree: Record<string, string>) => void,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = tempProject();
  try {
    const sql = openPostgres(database.url);
    try {
      for (const statement of statements) await sql.unsafe(statement);
    } finally {
      await sql.end({ timeout: 5 });
    }
    writeConfig(cwd, database.url);
    await pullProject(cwd, ["--out", "pulled"]);
    const tree = readTree(join(cwd, "pulled"));
    for (const path of Object.keys(tree)) expect(path).not.toContain("okm_");
    assertPull(tree);
    const empty = await createIsolatedDatabase();
    const next = tempProject();
    try {
      writeConfig(next, empty.url, "./pulled/schema.ts");
      copyTree(join(cwd, "pulled"), join(next, "pulled"));
      await run(["generate"], { cwd: next, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd: next, stdout: () => undefined });
      await run(["check"], { cwd: next, stdout: () => undefined });
      const files = migrationSql(next);
      await run(["generate"], { cwd: next, stdout: () => undefined });
      expect(migrationSql(next)).toEqual(files);
    } finally {
      rmSync(next, { recursive: true, force: true });
      await empty.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

type Project = { readonly cwd: string; readonly major: number; readonly url: string };

/** Runs `body` in a temporary project. The schema loads before `body`. */
async function inProject(source: string, body: (project: Project) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = tempProject();
  const sql = openPostgres(database.url);
  try {
    writeConfig(cwd, database.url);
    writeSchema(cwd, source);
    const version = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    const major = Math.floor(Number(version[0]?.v ?? "0") / 10_000);
    await body({ cwd, major, url: database.url });
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeSchema(cwd: string, source: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [`import { schema, sql, t, table } from ${pg};`, `export const app = ${source};`, ""].join(
      "\n",
    ),
  );
}

function writeConfig(cwd: string, url: string, schema = "./schema.ts"): void {
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: ${JSON.stringify(schema)},`,
      '  migrations: "./migrations",',
      '  out: "./.okm",',
      `  database: { url: ${JSON.stringify(url)} },`,
      "});",
      "",
    ].join("\n"),
  );
}

function tempProject(): string {
  return mkdtempSync(join(root, ".okm-roundtrip-"));
}

function migrationSql(cwd: string): string[] {
  const dir = join(cwd, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function readTree(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out[path.slice(directory.length + 1)] = readFileSync(path, "utf8");
    }
  };
  visit(directory);
  return out;
}

function copyTree(from: string, to: string): void {
  const visit = (dir: string, dest: string): void => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, entry.name);
      const next = join(dest, entry.name);
      if (entry.isDirectory()) visit(src, next);
      else if (entry.name.endsWith(".ts")) writeFileSync(next, sourceImports(src));
      else copyFileSync(src, next);
    }
  };
  visit(from, to);
}

/** A pulled file imports the package by name. CI has no `node_modules/okmodel`, so point it at the source. */
function sourceImports(file: string): string {
  return readFileSync(file, "utf8")
    .replaceAll('from "okmodel/pg"', `from ${pg}`)
    .replaceAll('from "okmodel/ext"', `from ${ext}`);
}

async function refusal(operation: Promise<unknown>): Promise<OkmError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}
