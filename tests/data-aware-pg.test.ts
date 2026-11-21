/**
 * Data-aware generate and apply on Postgres 17.
 *
 * The fill touches only empty rows, the probe is bounded, and apply stops
 * before the first step when a required column has no fill.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { hasPty, okm, okmPty, stripAnsi } from "./cli-output-harness.js";
import { probeTarget } from "../src/tooling/migrate/data-probe.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { loadMigrations } from "../src/tooling/migrate/files.js";
import { StepBoundaryStop } from "../src/tooling/migrate/step-engine.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

function project(body: string, url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "okm-data-"));
  writeFileSync(
    join(dir, "okmodel.config.ts"),
    `import { defineConfig } from ${migrate};\nexport default defineConfig({ schema: "./schema.ts", database: ${JSON.stringify(url)} });\n`,
  );
  writeFileSync(join(dir, "schema.ts"), body);
  return dir;
}

function tasks(columns: string, extra = ""): string {
  return `import { schema, table, t, sql } from ${pg};\nexport const app = schema({ tables: [table("tasks", {\n  id: t.integer().primaryKey(),\n${columns}\n}${extra})] });\n`;
}

function parents(): string {
  return `import { schema, table, t } from ${pg};\nconst parents = table("parents", { id: t.integer().primaryKey() });\nconst tasks = table("tasks", { id: t.integer().primaryKey(), parentId: t.integer().nullable().references("parents") });\nexport const app = schema({ tables: [parents, tasks] });\n`;
}

function sqlOf(dir: string, name: string): string {
  const file = readdirSync(join(dir, "migrations")).find(
    (item) => item.endsWith(".sql") && item.includes(name),
  );
  if (file === undefined) throw new Error(`missing ${name}`);
  return readFileSync(join(dir, "migrations", file), "utf8");
}

function run(dir: string, args: readonly string[]) {
  return okm(dir, args, { NO_COLOR: "1" });
}

postgresTest(gate, "a rename is written into the migration and the schema file stays", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  title: t.text(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const seeded = openPostgres(database.url);
    await seeded.unsafe("insert into tasks (id, title) values (1, 'kept')");
    await seeded.end({ timeout: 5 });
    const before = readFileSync(join(dir, "schema.ts"), "utf8");
    writeFileSync(dir + "/schema.ts", tasks("  name: t.text(),"));
    const refused = run(dir, ["generate", "rename_title"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("--rename tasks.title=name");
    expect(refused.stderr).toContain("--drop-and-add");
    const renamed = run(dir, ["generate", "rename_title", "--rename", "tasks.title=name"]);
    expect(sqlOf(dir, "rename_title")).toContain('rename column "title" to "name"');
    expect(readFileSync(join(dir, "schema.ts"), "utf8")).toBe(tasks("  name: t.text(),"));
    expect(readFileSync(join(dir, "schema.ts"), "utf8")).not.toContain("renamedFrom");
    expect(renamed.stderr + renamed.stdout).not.toContain("renamedFrom");
    rmSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(dir + "/schema.ts", tasks("  title: t.text(),"));
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    writeFileSync(dir + "/schema.ts", tasks("  name: t.text().nullable(),"));
    expect(run(dir, ["generate", "drop_add", "--drop-and-add"]).code).not.toBe(3);
    const dropped = sqlOf(dir, "drop_add");
    expect(dropped).toContain('drop column "title"');
    expect(dropped).toContain('add column "name"');
    expect(before).toContain("title");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(
  gate,
  "both rename answers and the drop count print on a terminal",
  async () => {
    if (!hasPty) return;
    const database = await createIsolatedDatabase();
    const dir = project(tasks("  title: t.text(),"), database.url);
    try {
      expect(run(dir, ["generate", "init"]).code).toBe(0);
      expect(run(dir, ["migrate", "apply"]).code).toBe(0);
      const sql = openPostgres(database.url);
      await sql.unsafe("insert into tasks (id, title) select g, 't' from generate_series(1, 3) g");
      await sql.end({ timeout: 5 });
      writeFileSync(dir + "/schema.ts", tasks("  name: t.text().nullable(),"));
      const yes = await okmPty(dir, ["generate", "rename_title"], {
        answers: ["1"],
        env: { NO_COLOR: "1" },
      });
      const plain = stripAnsi(yes.output);
      expect(plain).toContain("Is this a rename?");
      expect(plain).toContain("It keeps its 3 values.");
      expect(plain).toContain("I wrote 0002_rename_title.sql");
      expect(readFileSync(join(dir, "schema.ts"), "utf8")).not.toContain("renamedFrom");
      rmSync(join(dir, "migrations", "0002_rename_title.sql"));
      rmSync(join(dir, "migrations", "0002_rename_title.catalog.json"));
      const no = await okmPty(dir, ["generate", "split"], {
        answers: ["2", "y", "moved"],
        env: { NO_COLOR: "1" },
      });
      expect(stripAnsi(no.output)).toContain("3 values are lost.");
      expect(sqlOf(dir, "split")).toContain('drop column "title"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(gate, "a drop question names how many values are lost", async () => {
  if (!hasPty) return;
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  title: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, title) values (1, 'a'), (2, 'b'), (3, null)");
    await sql.end({ timeout: 5 });
    writeFileSync(dir + "/schema.ts", tasks(""));
    const ran = await okmPty(dir, ["generate", "drop_title"], {
      answers: ["n"],
      env: { NO_COLOR: "1" },
    });
    expect(stripAnsi(ran.output)).toContain("title holds 2 values. Drop it? [y/N]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "the fill is idempotent and leaves values and empty strings", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe(
      "insert into tasks (id, label) values (1, 'kept'), (2, ''), (3, null), (4, null)",
    );
    await sql.end({ timeout: 5 });
    writeFileSync(dir + "/schema.ts", tasks("  label: t.text(),"));
    const generated = run(dir, ["generate", "require_label", "--fill", "tasks.label='filled'"]);
    expect(generated.code).toBe(0);
    const text = sqlOf(dir, "require_label");
    const backfill = text.indexOf("update ");
    const check = text.indexOf("not valid");
    const second = text.indexOf("update ", backfill + 1);
    const validate = text.indexOf("validate constraint");
    const set = text.indexOf("set not null");
    expect(backfill).toBeGreaterThan(-1);
    expect(backfill).toBeLessThan(check);
    expect(check).toBeLessThan(second);
    expect(second).toBeLessThan(validate);
    expect(validate).toBeLessThan(set);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const after = openPostgres(database.url);
    const rows = await after.unsafe<{ label: string }[]>("select label from tasks order by id");
    expect(rows.map((row) => row.label)).toEqual(["kept", "", "filled", "filled"]);
    const again = run(dir, ["migrate", "apply"]);
    expect(again.code).toBe(0);
    const twice = await after.unsafe<{ label: string }[]>("select label from tasks order by id");
    expect(twice.map((row) => row.label)).toEqual(["kept", "", "filled", "filled"]);
    await after.end({ timeout: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "apply stops before any step when empty rows have no fill", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    writeFileSync(dir + "/schema.ts", tasks("  label: t.text(),"));
    expect(run(dir, ["generate", "require_label"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, label) values (1, null)");
    await sql.end({ timeout: 5 });
    const stopped = run(dir, ["migrate", "apply"]);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("Nothing was changed.");
    expect(stopped.stderr).toContain("--fill tasks.label=");
    const check = openPostgres(database.url);
    const nullable = await check.unsafe<{ n: string }[]>(
      "select attnotnull::text as n from pg_attribute where attrelid = 'tasks'::regclass and attname = 'label'",
    );
    expect(nullable[0]?.n).toBe("false");
    await check.unsafe("update tasks set label = 'ready'");
    await check.end({ timeout: 5 });
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "a missing fill on a populated column refuses with needs JSON", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, label) values (1, null), (2, 'kept')");
    await sql.end({ timeout: 5 });
    writeFileSync(dir + "/schema.ts", tasks("  label: t.text(),"));
    const refused = run(dir, ["generate", "require_label", "--json"]);
    expect(refused.code).toBe(1);
    const body = JSON.parse(refused.stdout) as {
      data: { needs: { flag: string; target: string; emptyRows: number; suggest: string[] } };
      errors: { code: string }[];
    };
    expect(body.errors[0]?.code).toBe("OKM1525");
    expect(body.data.needs).toEqual({
      flag: "--fill",
      target: "tasks.label",
      emptyRows: 1,
      suggest: [],
    });
    expect(
      readdirSync(join(dir, "migrations")).some((file) => file.includes("require_label")),
    ).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "plan --target prints the probe and the JSON field", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, label) values (1, null), (2, null), (3, 'kept')");
    await sql.end({ timeout: 5 });
    writeFileSync(dir + "/schema.ts", tasks("  label: t.text(),"));
    const planned = run(dir, ["migrate", "plan", "require_label", "--json"]);
    expect(planned.stdout).toContain("2 rows have no value");
    const body = JSON.parse(planned.stdout) as {
      data?: { steps: { data?: { emptyRows: number } }[] };
      steps?: { data?: { emptyRows: number } }[];
    };
    const steps = body.steps ?? body.data?.steps ?? [];
    expect(steps.some((step) => step.data?.emptyRows === 2)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "expression checks refuse a bad fill before writing", async () => {
  const database = await createIsolatedDatabase();
  const nullable = tasks(
    "  label: t.varchar(3).nullable(),\n  code: t.text().nullable().unique(),\n  n: t.integer().nullable(),",
    ", { checks: { positive: (c) => sql`${c.n} > 0` } }",
  );
  const dir = project(nullable, database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, label, code, n) values (1, null, null, null)");
    await sql.end({ timeout: 5 });
    const cases: readonly (readonly [string, string, string])[] = [
      [
        "tasks.label=now()",
        "longer than",
        "  label: t.varchar(3),\n  code: t.text().nullable().unique(),\n  n: t.integer().nullable(),",
      ],
      [
        "tasks.label=null",
        "is null",
        "  label: t.varchar(3),\n  code: t.text().nullable().unique(),\n  n: t.integer().nullable(),",
      ],
      [
        "tasks.label='abcdef'",
        "longer than",
        "  label: t.varchar(3),\n  code: t.text().nullable().unique(),\n  n: t.integer().nullable(),",
      ],
      [
        "tasks.n=-1",
        "does not pass",
        "  label: t.varchar(3).nullable(),\n  code: t.text().nullable().unique(),\n  n: t.integer(),",
      ],
      [
        "tasks.code='same'",
        "would collide",
        "  label: t.varchar(3).nullable(),\n  code: t.text().unique(),\n  n: t.integer().nullable(),",
      ],
      [
        "tasks.label='a'; drop table tasks",
        "semicolon",
        "  label: t.varchar(3),\n  code: t.text().nullable().unique(),\n  n: t.integer().nullable(),",
      ],
    ];
    for (const [flag, needle, columns] of cases) {
      writeFileSync(
        dir + "/schema.ts",
        tasks(columns, ", { checks: { positive: (c) => sql`${c.n} > 0` } }"),
      );
      const ran = run(dir, ["generate", "bad", "--fill", flag]);
      expect(ran.code, flag).not.toBe(0);
      expect(ran.stderr, flag).toContain(needle);
      expect(readdirSync(join(dir, "migrations")).some((file) => file.includes("_bad"))).toBe(
        false,
      );
      writeFileSync(dir + "/schema.ts", nullable);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "a constant missing from the parent is refused", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(parents(), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe('insert into tasks (id, "parentId") values (1, null)');
    await sql.end({ timeout: 5 });
    writeFileSync(
      dir + "/schema.ts",
      `import { schema, table, t } from ${pg};\nconst parents = table("parents", { id: t.integer().primaryKey() });\nconst tasks = table("tasks", { id: t.integer().primaryKey(), parentId: t.integer().references("parents") });\nexport const app = schema({ tables: [parents, tasks] });\n`,
    );
    const ran = run(dir, ["generate", "require_parent", "--fill", "tasks.parentId=99"]);
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain("is not in parents.id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(
  gate,
  "the probe is exact under 10000, capped above, and times out in 2s",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create table tasks (id integer primary key, title text)");
      await sql.unsafe("insert into tasks (id, title) select g, null from generate_series(1, 4) g");
      const few = await probeTarget(database.url, "public", [
        { table: "tasks", column: "title", which: "null" },
      ]);
      if (few === "unreachable") throw new Error("probe unreachable");
      expect(few[0]?.count).toEqual({ kind: "exact", n: 4 });
      await sql.unsafe(
        "insert into tasks (id, title) select g, null from generate_series(5, 10005) g",
      );
      const many = await probeTarget(database.url, "public", [
        { table: "tasks", column: "title", which: "null" },
      ]);
      if (many === "unreachable") throw new Error("probe unreachable");
      expect(many[0]?.count).toEqual({ kind: "least" });
      await sql.unsafe("analyze tasks");
      await sql.unsafe("update tasks set title = 'x' where id <= 10");
      const stats = await sql.unsafe<{ null_frac: string }[]>(
        "select null_frac::text as null_frac from pg_stats where tablename = 'tasks' and attname = 'title'",
      );
      expect(Number(stats[0]?.null_frac)).toBe(1);
      const valued = await probeTarget(database.url, "public", [
        { table: "tasks", column: "title", which: "notNull" },
      ]);
      if (valued === "unreachable") throw new Error("probe unreachable");
      expect(valued[0]?.count).toEqual({ kind: "exact", n: 10 });
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "a probe waiting on an exclusive lock times out",
  async () => {
    const database = await createIsolatedDatabase();
    const holder = openPostgres(database.url);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await holder.unsafe("create table tasks (id integer primary key, title text)");
      let locked: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const held = holder.begin(async (tx) => {
        await tx.unsafe("lock table tasks in access exclusive mode");
        locked();
        await released;
      });
      await ready;
      const started = Date.now();
      const result = await probeTarget(database.url, "public", [
        { table: "tasks", column: "title", which: "null" },
      ]);
      expect(Date.now() - started).toBeLessThan(4_000);
      if (result === "unreachable") throw new Error("probe unreachable");
      expect(result[0]?.count).toEqual({ kind: "unknown" });
      release();
      await held;
    } finally {
      release();
      await holder.end({ timeout: 5 });
      await database.close();
    }
  },
  4_000,
);

postgresTest(gate, "a concurrent writer is swept or rejected by the fill order", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),\n  note: t.text(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe(
      "insert into tasks (id, label, note) values (1, null, 'old'), (2, 'kept', 'stay')",
    );
    await sql.end({ timeout: 5 });
    writeFileSync(
      dir + "/schema.ts",
      tasks("  label: t.text().nullable(),\n  note: t.text(),").replace(
        "label: t.text().nullable()",
        "label: t.text()",
      ),
    );
    expect(run(dir, ["generate", "require_label", "--fill", "tasks.label='filled'"]).code).toBe(0);
    const file = readdirSync(join(dir, "migrations")).find(
      (item) => item.includes("require_label") && item.endsWith(".sql"),
    );
    if (file === undefined) throw new Error("missing migration");
    const statements = readFileSync(join(dir, "migrations", file), "utf8")
      .split(/;\n/)
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.startsWith("--") && line.trim().length > 0)
          .join("\n")
          .trim(),
      )
      .filter((part) => part.length > 0);
    const writer = openPostgres(database.url);
    let sawCheck = false;
    for (const statement of statements) {
      if (statement.startsWith("update ")) {
        await writer.unsafe(statement, [null, null]);
        if (!sawCheck) {
          await writer.unsafe("insert into tasks (id, label, note) values (3, null, 'late')");
          await writer.unsafe(
            "update tasks set note = 'touched' where label = 'filled' and note = 'old'",
          );
        }
        continue;
      }
      if (statement.includes("not valid")) {
        sawCheck = true;
        await writer.unsafe(statement);
        let rejected = false;
        try {
          await writer.unsafe("insert into tasks (id, label, note) values (4, null, 'blocked')");
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        continue;
      }
      await writer.unsafe(statement);
    }
    const rows = await writer.unsafe<{ label: string; note: string }[]>(
      "select label, note from tasks order by id",
    );
    const seen = [...rows].map((row) => ({ label: row.label, note: row.note }));
    expect(seen).toEqual([
      { label: "filled", note: "touched" },
      { label: "kept", note: "stay" },
      { label: "filled", note: "late" },
    ]);
    await writer.end({ timeout: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(gate, "apply interrupted after the first fill resumes", async () => {
  const database = await createIsolatedDatabase();
  const dir = project(tasks("  label: t.text().nullable(),"), database.url);
  try {
    expect(run(dir, ["generate", "init"]).code).toBe(0);
    expect(run(dir, ["migrate", "apply"]).code).toBe(0);
    const sql = openPostgres(database.url);
    await sql.unsafe("insert into tasks (id, label) values (1, null)");
    await sql.end({ timeout: 5 });
    writeFileSync(dir + "/schema.ts", tasks("  label: t.text(),"));
    expect(run(dir, ["generate", "require_label", "--fill", "tasks.label='filled'"]).code).toBe(0);
    const migrations = loadMigrations(join(dir, "migrations")).filter((item) =>
      item.id.includes("require_label"),
    );
    let stopped = false;
    try {
      await applyTarget({
        url: database.url,
        target: "data",
        protected: false,
        migrations,
        failAt: "after-ddl",
      });
    } catch (error) {
      stopped = error instanceof StepBoundaryStop;
      if (!stopped) throw error;
    }
    expect(stopped).toBe(true);
    await applyTarget({ url: database.url, target: "data", protected: false, migrations });
    const after = openPostgres(database.url);
    const rows = await after.unsafe<{ label: string; notnull: string }[]>(
      "select t.label, a.attnotnull::text as notnull from tasks t join pg_attribute a on a.attrelid = 'tasks'::regclass and a.attname = 'label'",
    );
    expect(rows[0]).toEqual({ label: "filled", notnull: "true" });
    await after.end({ timeout: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await database.close();
  }
});

postgresTest(
  gate,
  "a terminal asks what empty rows should get",
  async () => {
    if (!hasPty) return;
    const database = await createIsolatedDatabase();
    const dir = project(
      tasks("  dueAt: t.timestamptz().nullable(),\n  createdAt: t.timestamptz(),"),
      database.url,
    );
    try {
      expect(run(dir, ["generate", "init"]).code).toBe(0);
      expect(run(dir, ["migrate", "apply"]).code).toBe(0);
      const sql = openPostgres(database.url);
      await sql.unsafe(
        'insert into tasks (id, "dueAt", "createdAt") values (1, null, now()), (2, now(), now())',
      );
      await sql.end({ timeout: 5 });
      writeFileSync(
        dir + "/schema.ts",
        tasks("  dueAt: t.timestamptz(),\n  createdAt: t.timestamptz(),"),
      );
      const pretty = await okmPty(dir, ["generate", "require_due"], {
        answers: ["1"],
        env: { FORCE_COLOR: "1" },
      });
      const plainRun = stripAnsi(pretty.output);
      expect(plainRun).toContain("dueAt becomes required.");
      expect(plainRun).toContain("rows have no value");
      expect(plainRun).toContain("now()");
      expect(plainRun).toContain("I checked now() against the target");
      expect(plainRun).toContain("fill in batches of 1,000");
      for (const file of readdirSync(join(dir, "migrations"))) {
        if (file.startsWith("0002_")) rmSync(join(dir, "migrations", file));
      }
      const plain = run(dir, ["generate", "require_due_plain", "--fill", "tasks.dueAt=now()"]);
      expect(plain.stdout).toContain("I wrote");
      expect(plain.stdout).not.toContain("\u001b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);
