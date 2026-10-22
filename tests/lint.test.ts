/**
 * Linter rules, overrides, and the generate / plan / check / apply exits.
 *
 * A create from an empty catalog is the fixture history. It stays clean.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import type { Catalog, ColumnObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { enumColumn } from "../src/dialects/pg/enum.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import type { AnyTable } from "../src/dialects/pg/table.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { COLUMN_RULES, STEP_RULES } from "../src/tooling/migrate/lint-rules.js";
import {
  formatFindings,
  lintCatalog,
  lintMigrationDirectory,
  lintPlan,
  type Finding,
} from "../src/tooling/migrate/lint.js";
import { reprintHits } from "../src/tooling/migrate/reprint.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type MigrationPlan,
} from "../src/tooling/migrate/plan.js";

const tasks = () => table("tasks", { id: t.identity(), title: t.text() });

test("every rule has a one-line doc", () => {
  for (const rule of [...STEP_RULES, ...COLUMN_RULES]) {
    expect(rule.doc.includes("\n")).toBe(false);
    expect(rule.doc.length).toBeGreaterThan(rule.code.length);
  }
});

test("a data statement outside backfill is OKM1542 and a backfill update is not", () => {
  const empty = schema({ tables: [] }).catalog;
  const inserted = parsePlan("-- class: expand\n\ninsert into roles (code) values ('admin');\n");
  expect(lintPlan(inserted, empty, empty).some((item) => item.code === "OKM1542")).toBe(true);
  const filled = parsePlan(
    '-- class: expand\n\n-- backfill table="public"."roles" key="code" batch=100\nupdate "public"."roles" set "label" = \'x\' where "code" = \'a\';\n',
  );
  expect(lintPlan(filled, empty, empty).some((item) => item.code === "OKM1542")).toBe(false);
  expect(
    lintPlan(
      parsePlan('-- class: expand\n\ncreate table "roles" ("code" text);\n'),
      empty,
      empty,
    ).some((item) => item.code === "OKM1542"),
  ).toBe(false);
});

test("destructive drops are errors and a create is not", () => {
  expect(codes(diff(tasks(), table("tasks", { id: t.identity() })))).toContain("OKM1512");
  expect(codes(fromEmpty(tasks()))).not.toContain("OKM1512");
  expect(codes(fromEmpty(tasks()))).not.toContain("OKM1511");
  const notes = table("notes", { id: t.identity() });
  expect(codes(plans(schema({ tables: [tasks(), notes] }), schema({ tables: [notes] })))).toContain(
    "OKM1511",
  );

  const colored = table("tasks", {
    id: t.identity(),
    status: enumColumn("color", ["red", "blue"]),
  });
  expect(codes(diff(colored, table("tasks", { id: t.identity() })))).toContain("OKM1513");
  expect(codes(fromEmpty(colored))).not.toContain("OKM1513");

  const labeled = table("tasks", {
    id: t.identity(),
    name: t.domain("label", t.text(), "((length(VALUE) > 0))"),
  });
  expect(codes(diff(labeled, table("tasks", { id: t.identity() })))).toContain("OKM1514");
  expect(codes(fromEmpty(labeled))).not.toContain("OKM1514");

  const answer = fn("answer", { returns: "integer", language: "sql", body: "select 1" });
  const withFn = schema({ tables: [tasks()], functions: [answer] });
  const withoutFn = schema({ tables: [tasks()] });
  expect(codes(plans(withFn, withoutFn))).toContain("OKM1515");
  expect(codes(plans(schema({ tables: [] }), withFn))).not.toContain("OKM1515");

  const listed = view("titles", {
    columns: [{ name: "title", type: "text" }],
    query: "select title from tasks",
  });
  expect(
    codes(plans(schema({ tables: [tasks()], views: [listed] }), schema({ tables: [tasks()] }))),
  ).toContain("OKM1516");
  expect(codes(fromEmpty(schema({ tables: [tasks()], views: [listed] })))).not.toContain("OKM1516");

  const stored = materializedView("titles", {
    columns: [{ name: "title", type: "text" }],
    query: "select title from tasks",
  });
  expect(
    codes(plans(schema({ tables: [tasks()], views: [stored] }), schema({ tables: [tasks()] }))),
  ).toContain("OKM1518");
  expect(codes(fromEmpty(schema({ tables: [tasks()], views: [stored] })))).not.toContain("OKM1518");

  const extra = extension("pgcrypto");
  expect(
    codes(plans(schema({ tables: [tasks()], extensions: [extra] }), schema({ tables: [tasks()] }))),
  ).toContain("OKM1517");
  expect(codes(fromEmpty(schema({ tables: [tasks()], extensions: [extra] })))).not.toContain(
    "OKM1517",
  );
});

test("renames, type changes, required columns, and dropped defaults are errors", () => {
  const renamed = table("tasks", { id: t.identity(), contact: t.text().renamedFrom("title") });
  expect(codes(diff(tasks(), renamed))).toContain("OKM1519");
  expect(codes(fromEmpty(tasks()))).not.toContain("OKM1519");

  const kept = table("tasks", { id: t.text().primaryKey(), title: t.text() });
  const plan = {
    name: "rename",
    class: "contract" as const,
    steps: [
      {
        sql: 'alter table "public"."tasks" rename to "notes"',
        class: "contract" as const,
        kind: "rename-table" as const,
        action: "ddl" as const,
        lock: "ACCESS EXCLUSIVE",
        transactional: true,
      },
    ],
  };
  expect(lintPlan(plan, keptCatalog(kept), keptCatalog(kept)).map((item) => item.code)).toContain(
    "OKM1523",
  );
  expect(codes(fromEmpty(kept))).not.toContain("OKM1523");

  expect(codes(diff(tasks(), table("tasks", { id: t.identity(), title: t.integer() })))).toContain(
    "OKM1524",
  );
  expect(
    codes(
      diff(
        table("tasks", { id: t.identity(), title: t.integer() }),
        table("tasks", { id: t.identity(), n: t.integer().renamedFrom("title") }),
      ),
    ),
  ).not.toContain("OKM1524");

  expect(
    codes(diff(tasks(), table("tasks", { id: t.identity(), title: t.text(), note: t.text() }))),
  ).toContain("OKM1525");
  expect(
    codes(
      diff(
        tasks(),
        table("tasks", { id: t.identity(), title: t.text(), note: t.text().nullable() }),
      ),
    ),
  ).not.toContain("OKM1525");

  expect(
    codes(
      diff(
        table("tasks", { id: t.identity(), title: t.text().default("x") }),
        table("tasks", { id: t.identity(), title: t.text() }),
      ),
    ),
  ).toContain("OKM1526");
  expect(
    codes(diff(tasks(), table("tasks", { id: t.identity(), title: t.text().default("x") }))),
  ).not.toContain("OKM1526");

  expect(
    codes(
      diff(
        table("tasks", { id: t.identity(), title: t.varchar(30) }),
        table("tasks", { id: t.identity(), title: t.varchar(20) }),
      ),
    ),
  ).toEqual(["OKM1527", "OKM1538"]);
  expect(
    codes(
      diff(
        table("tasks", { id: t.identity(), title: t.varchar(20) }),
        table("tasks", { id: t.identity(), title: t.varchar(30) }),
      ),
    ),
  ).not.toContain("OKM1527");
});

test("unique, check, and foreign key rules see existing rows only", () => {
  const unique = table("tasks", { id: t.identity(), title: t.text().unique() });
  expect(codes(diff(tasks(), unique))).toContain("OKM1528");
  expect(codes(fromEmpty(unique))).not.toContain("OKM1528");

  const indexed = table(
    "tasks",
    { id: t.identity(), title: t.text() },
    { indexes: (columns) => [index(columns.title).unique()] },
  );
  expect(codes(diff(tasks(), indexed))).toContain("OKM1529");
  expect(codes(fromEmpty(indexed))).not.toContain("OKM1529");

  const plainIndex = table(
    "tasks",
    { id: t.identity(), title: t.text() },
    { indexes: (columns) => [index(columns.title)] },
  );
  expect(codes(diff(tasks(), plainIndex))).not.toContain("OKM1534");
  expect(codes(diff(tasks(), plainIndex))).not.toContain("OKM1529");
  expect(codes(fromEmpty(plainIndex))).not.toContain("OKM1534");
  const blocking = lintPlan(
    {
      name: "hand-index",
      class: "expand",
      steps: [
        {
          sql: 'create index "tasks_title_idx" on "public"."tasks" ("title")',
          class: "expand",
          kind: "create-index",
          action: "ddl",
          lock: "SHARE",
          transactional: true,
        },
      ],
    },
    schema({ tables: [tasks()] }).catalog,
    schema({ tables: [plainIndex] }).catalog,
  );
  expect(blocking.map((item) => item.code)).toContain("OKM1534");
  expect(blocking.find((item) => item.code === "OKM1534")?.severity).toBe("error");
  const concurrent = {
    name: "index",
    class: "expand" as const,
    steps: [
      {
        sql: 'create index concurrently "tasks_title" on "public"."tasks" ("title")',
        class: "expand" as const,
        kind: "create-index" as const,
        action: "ddl" as const,
        lock: "SHARE",
        transactional: false,
      },
    ],
  };
  const existing = schema({ tables: [tasks()] }).catalog;
  expect(lintPlan(concurrent, existing, existing).map((item) => item.code)).not.toContain(
    "OKM1534",
  );

  const checked = table("tasks", { id: t.identity(), title: t.text().picklist(["a", "b"]) });
  const open = table("tasks", { id: t.identity(), title: t.text() });
  const checkCodes = codes(diff(open, checked));
  expect(checkCodes).toContain("OKM1531");
  expect(checkCodes).not.toContain("OKM1535");
  expect(codes(fromEmpty(checked))).not.toContain("OKM1531");

  const withStatus = table("tasks", {
    id: t.identity(),
    title: t.text(),
    status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),
  });
  const addedPicklist = diff(open, withStatus);
  expect(addedPicklist.plan.steps.map((step) => step.sql).join("\n")).toContain("not valid");
  expect(codes(addedPicklist)).not.toContain("OKM1531");
  expect(codes(addedPicklist)).not.toContain("OKM1535");

  const nullableStatus = table("tasks", {
    id: t.identity(),
    title: t.text(),
    status: t.varchar(20).nullable().picklist(["draft", "active", "done"]),
  });
  expect(codes(diff(open, nullableStatus))).not.toContain("OKM1531");

  const volatileToken = table("tasks", {
    id: t.identity(),
    title: t.text(),
    token: t.uuid().picklist(["a"]).defaultSql("gen_random_uuid()"),
  });
  expect(codes(diff(open, volatileToken))).toContain("OKM1531");
  const bareCheck = lintPlan(
    {
      name: "hand-check",
      class: "expand",
      steps: [
        {
          sql: `alter table "public"."tasks" add constraint "tasks_title_check" check ((title IN ('a', 'b')))`,
          class: "expand",
          kind: "add-constraint",
          action: "ddl",
          lock: "ACCESS EXCLUSIVE",
          transactional: true,
        },
      ],
    },
    schema({ tables: [open] }).catalog,
    schema({ tables: [checked] }).catalog,
  );
  expect(bareCheck.map((item) => item.code)).toContain("OKM1535");
  expect(bareCheck.find((item) => item.code === "OKM1535")?.severity).toBe("error");

  const wider = table("tasks", {
    id: t.identity(),
    title: t.text().picklist(["a", "b"]).default("a"),
  });
  const narrower = table("tasks", {
    id: t.identity(),
    title: t.text().picklist(["a"]).default("a"),
  });
  const widened = diff(narrower, wider);
  const validate = widened.plan.steps.find((step) => step.sql.includes("validate constraint"));
  expect(validate).toBeDefined();
  expect(codes(widened)).toEqual([]);
  expect(codesOf(widened, validate?.sql ?? "")).not.toContain("OKM1531");
  expect(codesOf(widened, validate?.sql ?? "")).not.toContain("OKM1535");

  const users = table("users", { id: t.identity(), name: t.text() });
  const owned = table("tasks", {
    id: t.identity(),
    title: t.text(),
    ownerId: t.bigint().references("users"),
  });
  const linked = codes(
    plans(schema({ tables: [users, tasks()] }), schema({ tables: [users, owned] })),
  );
  expect(linked).toContain("OKM1532");
  expect(linked).not.toContain("OKM1536");
  expect(codes(fromEmpty(schema({ tables: [users, owned] })))).not.toContain("OKM1532");
  const bareKey = lintPlan(
    {
      name: "hand-fk",
      class: "expand",
      steps: [
        {
          sql: 'alter table "public"."tasks" add constraint "tasks_owner_id_fkey" foreign key ("owner_id") references "public"."users" ("id")',
          class: "expand",
          kind: "add-constraint",
          action: "ddl",
          lock: "ACCESS EXCLUSIVE",
          transactional: true,
        },
      ],
    },
    schema({ tables: [users, tasks()] }).catalog,
    schema({ tables: [users, owned] }).catalog,
  );
  expect(bareKey.map((item) => item.code)).toContain("OKM1536");
  expect(bareKey.find((item) => item.code === "OKM1536")?.severity).toBe("error");
});

test("locking errors cover an unsafe set not null, and a rewriting type change stays a warning", () => {
  const loose = table("tasks", { id: t.identity(), title: t.text().nullable() });
  const tight = table("tasks", { id: t.identity(), title: t.text() });
  const set = codes(diff(loose, tight));
  expect(set).not.toContain("OKM1537");
  expect(set).not.toContain("OKM1531");
  expect(set).not.toContain("OKM1525");
  const bare = lintPlan(
    {
      name: "hand-null",
      class: "contract",
      steps: [
        {
          sql: 'alter table "public"."tasks" alter column "title" set not null',
          class: "contract",
          kind: "set-not-null",
          action: "ddl",
          lock: "ACCESS EXCLUSIVE",
          transactional: true,
        },
      ],
    },
    schema({ tables: [loose] }).catalog,
    schema({ tables: [tight] }).catalog,
  );
  expect(bare.map((item) => item.code)).toEqual(["OKM1537"]);
  expect(bare[0]?.severity).toBe("error");

  const rewritten = codes(diff(tasks(), table("tasks", { id: t.identity(), title: t.integer() })));
  expect(rewritten).toContain("OKM1538");
  expect(
    diff(tasks(), table("tasks", { id: t.identity(), title: t.integer() })).findings.find(
      (item) => item.code === "OKM1538",
    )?.severity,
  ).toBe("warning");
  const shrunk = codes(
    diff(
      table("tasks", { id: t.identity(), title: t.varchar(30) }),
      table("tasks", { id: t.identity(), title: t.varchar(20) }),
    ),
  );
  expect(shrunk).toEqual(["OKM1527", "OKM1538"]);

  const narrowed = codes(
    diff(
      table("tasks", { id: t.identity(), n: t.bigint() }),
      table("tasks", { id: t.identity(), n: t.integer() }),
    ),
  );
  expect(narrowed).toContain("OKM1533");
  expect(narrowed).toContain("OKM1524");
  expect(
    codes(
      diff(
        table("tasks", { id: t.identity(), n: t.integer() }),
        table("tasks", { id: t.identity(), n: t.bigint() }),
      ),
    ),
  ).not.toContain("OKM1533");
});

test("type preferences warn on the catalog and not on a text identity table", () => {
  const plain = fromEmpty(tasks());
  expect(lintCatalog(plain.after)).toEqual([]);

  const stamped = schema({
    tables: [
      table("tasks", { id: t.identity(), at: t.timestamp(), name: t.varchar(20), body: t.json() }),
    ],
  });
  expect(
    lintCatalog(stamped.catalog)
      .map((item) => item.code)
      .sort(),
  ).toEqual(["OKM1539", "OKM1540", "OKM1544"]);

  const serial = withColumn(schema({ tables: [tasks()] }).catalog, "title", {
    dataType: "int4",
    defaultExpression: "nextval('tasks_title_seq'::regclass)",
  });
  expect(lintCatalog(serial).map((item) => item.code)).toContain("OKM1543");
  expect(lintCatalog(schema({ tables: [tasks()] }).catalog).map((item) => item.code)).not.toContain(
    "OKM1543",
  );

  const byDefault = withColumn(schema({ tables: [tasks()] }).catalog, "id", {
    identity: { always: false },
  });
  expect(lintCatalog(byDefault).map((item) => item.code)).toContain("OKM1545");
  expect(lintCatalog(schema({ tables: [tasks()] }).catalog).map((item) => item.code)).not.toContain(
    "OKM1545",
  );
});

test("an override needs a reason and only silences the code it names", () => {
  const planned = plans(
    schema({ tables: [tasks(), table("notes", { id: t.identity() })] }),
    schema({ tables: [table("notes", { id: t.identity() })] }),
  );
  const allowed = allow(planned, "OKM1511", "retiring the table");
  expect(codes(allowed)).not.toContain("OKM1511");
  expect(hasErrorCode(allowed, "OKM1510")).toBe(false);

  const empty = allow(planned, "OKM1511", "");
  expect(codes(empty)).toContain("OKM1511");
  expect(hasErrorCode(empty, "OKM1510")).toBe(true);

  const wrong = allow(planned, "OKM1512", "not this statement");
  expect(codes(wrong)).toContain("OKM1511");
  expect(formatFindings(wrong.findings)).toContain("override OKM1512 does not match");

  const unrelated = allow(planned, "OKM1539", "preference");
  expect(codes(unrelated)).toContain("OKM1511");
  expect(formatFindings(unrelated.findings)).toContain("error OKM1510");
});

test("generate writes the file, and plan and check fail on an error", async () => {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-lint-"));
  const applyDir = mkdtempSync(join(tmpdir(), "okm-lint-apply-"));
  const dropDir = mkdtempSync(join(tmpdir(), "okm-lint-drop-"));
  try {
    writeProject(
      cwd,
      root,
      'table("tasks", { id: identity(), title: text() }), table("notes", { id: identity(), name: text() })',
    );
    const lines: string[] = [];
    await run(["generate"], { cwd, stdout: (text) => lines.push(text) });
    const created = lines.join("");
    expect(created.trim().endsWith(".sql")).toBe(true);
    expect(created).not.toContain("OKM15");

    writeProject(dropDir, root, 'table("notes", { id: identity(), name: text() })');
    mkdirSync(join(dropDir, "migrations"));
    writeFileSync(
      join(dropDir, "migrations", "0001_base.catalog.json"),
      serializeCatalog(
        schema({
          tables: [tasks(), table("notes", { id: t.identity(), name: t.text() })],
        }).catalog,
      ),
    );
    lines.length = 0;
    const planned = await rejected(async () => {
      await run(["migrate", "plan", "drop"], { cwd: dropDir, stdout: (text) => lines.push(text) });
    });
    expect(planned.code).toBe("OKM1510");
    expect(lines.join("")).toContain("-- class:");
    expect(lines.join("")).toContain("error OKM1511");

    const checked = await rejected(async () => {
      await run(["check"], { cwd: dropDir, stdout: () => {} });
    });
    expect(checked.code).toBe("OKM1510");
    expect(checked.message).toContain("error OKM1511");

    lines.length = 0;
    const generated = await rejected(async () => {
      await run(["generate"], { cwd: dropDir, stdout: (text) => lines.push(text) });
    });
    expect(generated.code).toBe("OKM1510");
    expect(generated.fix.summary).toContain("apply will refuse until it is fixed");
    const written = lines.join("");
    const sqlPath = written.split("\n")[0] ?? "";
    expect(sqlPath.endsWith(".sql")).toBe(true);
    expect(existsSync(sqlPath)).toBe(true);
    expect(written).toContain("error OKM1511");
    expect(generated.message).toContain("error OKM1511");

    const drop = plans(
      schema({ tables: [tasks(), table("notes", { id: t.identity() })] }),
      schema({ tables: [table("notes", { id: t.identity() })] }),
    );
    mkdirSync(join(applyDir, "migrations"));
    writeFileSync(join(applyDir, "migrations", "0001_drop.sql"), formatPlan(drop.plan));
    writeFileSync(
      join(applyDir, "migrations", "0001_drop.catalog.json"),
      serializeCatalog(drop.after),
    );
    expect(
      lintMigrationDirectory(join(applyDir, "migrations"))[0]?.place.startsWith("0001_drop"),
    ).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dropDir, { recursive: true, force: true });
    rmSync(applyDir, { recursive: true, force: true });
  }
});

test("okm generate exits 1 on an error finding and still writes the file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-gen-err-"));
  try {
    writeProject(cwd, repoRoot(), 'table("notes", { id: identity(), name: text() })');
    mkdirSync(join(cwd, "migrations"));
    writeFileSync(
      join(cwd, "migrations", "0001_base.catalog.json"),
      serializeCatalog(
        schema({
          tables: [tasks(), table("notes", { id: t.identity(), name: t.text() })],
        }).catalog,
      ),
    );
    const proc = Bun.spawnSync(
      ["bun", join(repoRoot(), "src/tooling/cli.ts"), "generate", "drop"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(1);
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    const sqlPath = stdout.split("\n")[0] ?? "";
    expect(sqlPath.endsWith(".sql")).toBe(true);
    expect(existsSync(sqlPath)).toBe(true);
    expect(readFileSync(sqlPath, "utf8")).toContain("drop");
    expect(stdout).toContain("error OKM1511");
    expect(stderr).toContain("error OKM1510:");
    expect(stderr).toContain("apply will refuse until it is fixed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("okm generate exits 0 on a warning-only finding", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-gen-warn-"));
  const root = repoRoot();
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { identity, schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'export const app = schema({ tables: [table("tasks", { id: identity(), title: t.char(8) })] });',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "migrations"));
    writeFileSync(
      join(cwd, "migrations", "0001_base.catalog.json"),
      serializeCatalog(
        schema({ tables: [table("tasks", { id: t.identity(), title: t.char(3) })] }).catalog,
      ),
    );
    const proc = Bun.spawnSync(["bun", join(root, "src/tooling/cli.ts"), "generate", "widen"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    expect(stdout.split("\n")[0]?.endsWith(".sql")).toBe(true);
    expect(stdout).toContain("warning OKM1538");
    expect(stdout).not.toContain("error OKM");
    expect(proc.stderr.toString()).not.toContain("apply will refuse");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a later file is linted against the previous catalog, and an applied id is skipped", () => {
  const directory = mkdtempSync(join(tmpdir(), "okm-lint-dir-"));
  try {
    const created = schema({ tables: [tasks()] });
    const unique = schema({
      tables: [table("tasks", { id: t.identity(), title: t.text().unique() })],
    });
    const first = plans(schema({ tables: [] }), created);
    const second = plans(created, unique);
    mkdirSync(join(directory, "migrations"));
    writeMigration(directory, "0001_create", first);
    writeMigration(directory, "0002_unique", second);
    const migrations = join(directory, "migrations");
    const pending = lintMigrationDirectory(migrations, new Set(["0002_unique"]));
    expect(pending.map((item) => item.code)).toContain("OKM1528");
    expect(pending.some((item) => item.place.startsWith("0001_create"))).toBe(false);
    const applied = lintMigrationDirectory(migrations, new Set(["0001_create"]));
    expect(applied.some((item) => item.code === "OKM1528")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a leading comment does not hide truncate (QA-H3)", () => {
  const findings = hand("/* note */ truncate logs;");
  expect(findings.map((item) => `${item.place} ${item.code}`)).toEqual(["step 1 OKM1542"]);
});

test("a second statement in the same step is linted (QA-H3)", () => {
  const findings = hand('select 1; drop table "public"."logs";');
  expect(findings.map((item) => `${item.place} ${item.code}`)).toEqual([
    "step 1 statement 2 OKM1511",
  ]);
});

test("a semicolon inside a block comment does not hide the next statement (QA-H3)", () => {
  const findings = hand("select 1 /* ; */; delete from logs;");
  expect(findings.map((item) => `${item.place} ${item.code}`)).toEqual([
    "step 1 statement 2 OKM1542",
  ]);
});

test("a DO block is OKM1542 because its body is not analysed (QA-H3)", () => {
  for (const sql of ["do $$ begin delete from logs; end $$;", "call refresh_logs();"]) {
    const findings = hand(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OKM1542");
    expect(findings[0]?.place).toBe("step 1");
    expect(findings[0]?.reason).toBe("the body is not analysed");
  }
  const filled = parsePlan(
    '-- class: expand\n\n-- backfill table="public"."logs" key="id" batch=100\ndo $$ begin delete from logs; end $$;\n',
  );
  const empty = schema({ tables: [] }).catalog;
  expect(
    lintPlan(filled, empty, empty).some((item) => item.reason === "the body is not analysed"),
  ).toBe(true);
});

test("alter column type is the same type change as set data type (QA-H3)", () => {
  const shorthand = hand("alter table users alter column age type bigint;");
  const using = hand("alter table users alter column age type bigint using age::bigint;");
  const spelled = hand("alter table users alter column age set data type bigint;");
  for (const findings of [shorthand, using, spelled]) {
    expect(findings.map((item) => item.code).sort()).toEqual(["OKM1524", "OKM1538"]);
    expect(findings.every((item) => item.place === "step 1")).toBe(true);
  }
});

test("words inside a string, a comment, or a function body are not statements (QA-H3)", () => {
  expect(codesOfHand("select 'drop table logs;';")).toEqual([]);
  expect(codesOfHand("select 1 /* ; drop table logs */ ;")).toEqual([]);
  expect(codesOfHand("/* drop table logs; */ select 1;")).toEqual([]);
  expect(
    codesOfHand(
      "create function f() returns void language plpgsql as $$ begin delete from logs; end $$;",
    ),
  ).toEqual([]);
  expect(
    codesOfHand(
      "create procedure p() language plpgsql as $body$ begin delete from logs; end $body$;",
    ),
  ).toEqual([]);
});

test("an allow on a multi-statement step silences that code on every statement (QA-H3)", () => {
  const empty = schema({ tables: [] }).catalog;
  const silenced = lintPlan(
    parsePlan(
      "-- name: hand\n\n-- okm-allow OKM1542: clear the table once\nselect 1;\ntruncate logs;\ndelete from logs;\n",
    ),
    empty,
    empty,
  );
  expect(silenced.map((item) => item.code)).not.toContain("OKM1542");
  expect(silenced.map((item) => item.code)).not.toContain("OKM1510");

  const missed = lintPlan(
    parsePlan("-- name: hand\n\n-- okm-allow OKM1511: not a drop\ntruncate logs;\n"),
    empty,
    empty,
  );
  expect(missed.map((item) => `${item.place} ${item.code}`).sort()).toEqual([
    "step 1 OKM1510",
    "step 1 OKM1542",
  ]);
});

test("earlier and later steps are read statement by statement (QA-H3)", () => {
  const before = schema({ tables: [tasks()] }).catalog;
  const index = {
    sql: 'create unique index concurrently "tasks_title_idx" on "public"."tasks" ("title")',
    class: "expand" as const,
    kind: "create-index" as const,
    action: "ddl" as const,
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional: false,
  };
  const consumed = lintPlan(
    {
      name: "hand",
      class: "expand",
      steps: [
        index,
        {
          sql: 'select 1; alter table "public"."tasks" add constraint "tasks_title_key" unique using index "tasks_title_idx"',
          class: "expand",
          action: "ddl",
          lock: "ACCESS EXCLUSIVE",
          transactional: true,
        },
      ],
    },
    before,
    before,
  );
  expect(consumed.map((item) => item.code)).toContain("OKM1528");
  expect(consumed.map((item) => item.code)).not.toContain("OKM1529");

  const commented = lintPlan(
    {
      name: "hand",
      class: "expand",
      steps: [
        index,
        {
          sql: '/* using index "tasks_title_idx" */ select 1',
          class: "expand",
          action: "ddl",
          lock: "",
          transactional: true,
        },
      ],
    },
    before,
    before,
  );
  expect(commented.map((item) => item.code)).toContain("OKM1529");
  expect(commented.map((item) => item.code)).not.toContain("OKM1528");

  const loose = schema({
    tables: [table("tasks", { id: t.identity(), title: t.text().nullable() })],
  }).catalog;
  const tight = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] }).catalog;
  const safe = lintPlan(
    {
      name: "hand",
      class: "contract",
      steps: [
        {
          sql: 'select 1; alter table "public"."tasks" add constraint "tasks_title_not_null" check ("title" is not null) not valid',
          class: "expand",
          action: "ddl",
          lock: "",
          transactional: true,
        },
        {
          sql: '/* note */ alter table "public"."tasks" validate constraint "tasks_title_not_null"',
          class: "expand",
          action: "ddl",
          lock: "",
          transactional: true,
        },
        {
          sql: 'alter table "public"."tasks" alter column "title" set not null',
          class: "contract",
          kind: "set-not-null",
          action: "ddl",
          lock: "",
          transactional: true,
        },
      ],
    },
    loose,
    tight,
  );
  expect(safe.map((item) => item.code)).not.toContain("OKM1537");
  expect(safe.map((item) => item.code)).not.toContain("OKM1531");
});

test("a generated create with an index, a unique, and a foreign key lints clean", () => {
  const users = table("users", { id: t.identity(), name: t.text() });
  const owned = table(
    "tasks",
    { id: t.identity(), ownerId: t.bigint().references("users"), title: t.text() },
    { indexes: (columns) => [index(columns.title).unique()] },
  );
  const app = schema({
    tables: [users, owned],
    views: [
      view("titles", {
        columns: [{ name: "title", type: "text" }],
        query: "select title from tasks",
      }),
    ],
  });
  const planned = fromEmpty(app);
  expect(formatFindings(planned.findings)).toBe("");
  expect(lintCatalog(app.catalog)).toEqual([]);
});

type Planned = {
  readonly plan: MigrationPlan;
  readonly before: Catalog;
  readonly after: Catalog;
  readonly findings: readonly Finding[];
};

type Built = {
  readonly catalog: Catalog;
  readonly tables: readonly AnyTable[];
  readonly casing: "snake" | undefined;
};

test("OKM1551 flags transaction control and an allow needs a reason", () => {
  expect(codesOfHand("commit")).toContain("OKM1551");
  expect(codesOfHand("COMMIT WORK")).toContain("OKM1551");
  for (const form of [
    "commit and chain",
    "commit and no chain",
    "commit work and chain",
    "commit transaction and no chain",
    "end and chain",
    "end work and no chain",
    "end transaction and chain",
    "rollback and chain",
    "rollback work and no chain",
    "rollback transaction and chain",
    "abort",
    "abort work",
    "abort and chain",
    "abort transaction and no chain",
  ]) {
    expect({ form, codes: codesOfHand(`select 1;\n${form}`) }).toEqual({
      form,
      codes: expect.arrayContaining(["OKM1551"]),
    });
  }
  expect(codesOfHand("end")).toContain("OKM1551");
  expect(codesOfHand("rollback")).toContain("OKM1551");
  expect(codesOfHand("begin")).toContain("OKM1551");
  expect(codesOfHand("start transaction")).toContain("OKM1551");
  expect(codesOfHand("prepare transaction 'x'")).toContain("OKM1551");
  expect(codesOfHand("commit prepared 'x'")).toContain("OKM1551");
  expect(codesOfHand("select 1;\ncommit")).toContain("OKM1551");
  expect(codesOfHand("select 1;\r\ncommit")).toContain("OKM1551");
  expect(codesOfHand("do $$ begin commit; end $$")).toContain("OKM1551");
  expect(codesOfHand("do $$ begin rollback; end $$")).toContain("OKM1551");
  expect(codesOfHand("do language plpgsql $$ begin commit; end $$")).toContain("OKM1551");
  expect(
    codesOfHand(
      "create function public.f() returns void language plpgsql as $$ begin commit; end $$",
    ),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand(
      "create function public.f() returns void language plpgsql as $$ begin rollback; end $$",
    ),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand("create procedure public.p() language plpgsql as $$ begin commit; end $$"),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand("create procedure public.p() language plpgsql as $$ begin rollback; end $$"),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand(
      "create function public.f() returns int language plpgsql as $$ begin return 1; end $$",
    ),
  ).not.toContain("OKM1551");
  expect(codesOfHand("rollback to savepoint s")).not.toContain("OKM1551");
  expect(codesOfHand("end if")).not.toContain("OKM1551");
  expect(codesOfHand("-- okm-allow OKM1551: reviewed\ncommit")).not.toContain("OKM1551");
  expect(codesOfHand("-- okm-allow OKM1551:\ncommit")).toContain("OKM1551");
});

test("BEGIN ATOMIC in create function or procedure stays one statement", () => {
  expect(
    codesOfHand("create function f() returns int language sql begin atomic select 1; end"),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand(
      "create function f() returns int language sql begin atomic select 1; select 2; end",
    ),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand(
      "create function f() returns int language sql begin atomic select case when true then 1 else case when false then 2 else 3 end end; end",
    ),
  ).not.toContain("OKM1551");
  expect(codesOfHand("create procedure p() language sql begin atomic select 1; end")).not.toContain(
    "OKM1551",
  );
  expect(
    codesOfHand(
      "create or replace function public.f() returns int language sql begin atomic select 1; end",
    ),
  ).not.toContain("OKM1551");
  expect(
    codesOfHand("create function f() returns int language sql begin atomic select 1; end;\ncommit"),
  ).toContain("OKM1551");
  const rollback = hand(
    "create function public.f() returns int language sql begin atomic select 1; end; rollback",
  );
  expect(rollback.some((item) => item.code === "OKM1551" && item.reason.includes("rollback"))).toBe(
    true,
  );
  expect(codesOfHand("begin atomic select 1; end")).toContain("OKM1551");
  expect(codesOfHand("begin atomic select 1; end;\ncommit")).toContain("OKM1551");
});

test("every step rule fires, stays quiet on its safe form, and honors an override", () => {
  const existing = schema({ tables: [tasks()] }).catalog;
  const empty = schema({ tables: [] }).catalog;
  const wide = schema({ tables: [table("tasks", { title: t.varchar(30) })] }).catalog;
  const short = schema({ tables: [table("tasks", { title: t.varchar(20) })] }).catalog;
  const big = schema({ tables: [table("tasks", { n: t.bigint() })] }).catalog;
  const small = schema({ tables: [table("tasks", { n: t.integer() })] }).catalog;
  const textTitle = schema({ tables: [table("tasks", { title: t.text() })] }).catalog;
  const intTitle = schema({ tables: [table("tasks", { title: t.integer() })] }).catalog;
  const labeled = schema({
    tables: [
      table("tasks", {
        id: t.identity(),
        name: t.domain("label", t.text(), "((length(VALUE) > 0))"),
      }),
    ],
  }).catalog;
  const colored = schema({
    tables: [table("tasks", { id: t.identity(), status: t.enum("color", ["red", "blue"]) })],
  }).catalog;
  const fixtures: readonly Fixture[] = [
    { code: "OKM1511", fire: 'drop table "tasks"', safe: 'create table "tasks" ("id" bigint)' },
    {
      code: "OKM1512",
      fire: 'alter table "tasks" drop column "title"',
      safe: 'create table "tasks" ("id" bigint)',
    },
    {
      code: "OKM1513",
      fire: 'drop type "color"',
      safe: "create type \"color\" as enum ('red')",
      before: colored,
      after: colored,
    },
    {
      code: "OKM1514",
      fire: 'drop type "label"',
      safe: 'create table "tasks" ("id" bigint)',
      before: labeled,
      after: labeled,
    },
    {
      code: "OKM1515",
      fire: 'drop function "answer"()',
      safe: 'create table "tasks" ("id" bigint)',
    },
    { code: "OKM1516", fire: 'drop view "titles"', safe: 'create table "tasks" ("id" bigint)' },
    {
      code: "OKM1517",
      fire: 'drop extension "pgcrypto"',
      safe: 'create table "tasks" ("id" bigint)',
    },
    {
      code: "OKM1518",
      fire: 'drop materialized view "titles"',
      safe: 'create table "tasks" ("id" bigint)',
    },
    {
      code: "OKM1519",
      fire: 'alter table "tasks" rename column "title" to "name"',
      safe: 'create table "tasks" ("id" bigint)',
    },
    {
      code: "OKM1523",
      fire: 'alter table "tasks" rename to "notes"',
      safe: 'create table "tasks" ("id" bigint)',
    },
    {
      code: "OKM1524",
      fire: 'alter table "tasks" alter column "title" type integer',
      safe: 'create table "tasks" ("id" bigint)',
      before: textTitle,
      after: intTitle,
    },
    {
      code: "OKM1525",
      fire: 'alter table "tasks" add column "note" text not null',
      safe: 'alter table "tasks" add column "note" text',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1526",
      fire: 'alter table "tasks" alter column "title" drop default',
      safe: 'alter table "tasks" alter column "title" set default \'x\'',
    },
    {
      code: "OKM1527",
      fire: 'alter table "tasks" alter column "title" type varchar(20)',
      safe: 'alter table "tasks" alter column "title" type varchar(30)',
      before: wide,
      after: short,
      safeBefore: short,
      safeAfter: wide,
    },
    {
      code: "OKM1528",
      fire: 'alter table "tasks" add constraint "tasks_title_key" unique ("title")',
      safe: 'alter table "tasks" add constraint "tasks_title_key" unique using index "tasks_title_idx"',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1529",
      fire: 'create unique index "tasks_title_idx" on "tasks" ("title")',
      safe: 'create unique index "tasks_title_idx" on "tasks" ("title")',
      before: existing,
      after: existing,
    },
    {
      code: "OKM1531",
      fire: 'alter table "tasks" validate constraint "tasks_title_check"',
      safe: 'alter table "tasks" add constraint "tasks_title_check" check ((title <> \'\')) not valid',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1532",
      fire: 'alter table "tasks" add constraint "tasks_owner_fkey" foreign key ("owner_id") references "users" ("id")',
      safe: 'alter table "tasks" add constraint "tasks_owner_fkey" foreign key ("owner_id") references "users" ("id") not valid',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1533",
      fire: 'alter table "tasks" alter column "n" type integer',
      safe: 'alter table "tasks" alter column "n" type bigint',
      before: big,
      after: small,
      safeBefore: small,
      safeAfter: big,
    },
    {
      code: "OKM1534",
      fire: 'create index "tasks_title_idx" on "tasks" ("title")',
      safe: 'create index concurrently "tasks_title_idx" on "tasks" ("title")',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1535",
      fire: 'alter table "tasks" add constraint "tasks_title_check" check ((title <> \'\'))',
      safe: 'alter table "tasks" add constraint "tasks_title_check" check ((title <> \'\')) not valid',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1536",
      fire: 'alter table "tasks" add constraint "tasks_owner_fkey" foreign key ("owner_id") references "users" ("id")',
      safe: 'alter table "tasks" add constraint "tasks_owner_fkey" foreign key ("owner_id") references "users" ("id") not valid',
      before: existing,
      after: existing,
      safeBefore: existing,
      safeAfter: existing,
    },
    {
      code: "OKM1537",
      fire: 'alter table "tasks" alter column "title" set not null',
      safe: 'alter table "tasks" alter column "title" set not null',
      before: existing,
      after: existing,
    },
    {
      code: "OKM1538",
      fire: 'alter table "tasks" alter column "title" type integer',
      safe: 'alter table "tasks" alter column "title" type varchar(30)',
      before: textTitle,
      after: intTitle,
      safeBefore: short,
      safeAfter: wide,
    },
    {
      code: "OKM1542",
      fire: 'insert into "tasks" ("title") values (\'a\')',
      safe: '-- backfill table="public"."tasks" key="id" batch=100\nupdate "public"."tasks" set "title" = \'x\' where "id" = \'a\'',
    },
    {
      code: "OKM1550",
      fire: 'alter table "tasks" disable row level security',
      safe: 'create table "tasks" ("id" bigint)',
    },
    { code: "OKM1551", fire: "commit", safe: 'create table "tasks" ("id" bigint)' },
    {
      code: "OKM1557",
      fire: "-- transactional: false\nvacuum analyze notes",
      safe: "-- probe: select true\n-- transactional: false\nvacuum analyze notes",
    },
    {
      code: "OKM1558",
      fire: "-- probe: delete from notes\n-- transactional: false\nvacuum analyze notes",
      safe: "-- probe: select true\n-- transactional: false\nvacuum analyze notes",
    },
  ];
  expect(fixtures.map((item) => item.code).sort()).toEqual(
    STEP_RULES.map((rule) => rule.code).sort(),
  );
  for (const item of fixtures) {
    const fired = lintSql(item.fire, item.before ?? empty, item.after ?? item.before ?? empty);
    expect(
      fired.map((finding) => finding.code),
      item.code,
    ).toContain(item.code);
    const rule = STEP_RULES.find((entry) => entry.code === item.code);
    expect(fired.find((finding) => finding.code === item.code)?.severity, item.code).toBe(
      rule?.severity,
    );
    const quiet = lintSql(
      item.safe,
      item.safeBefore ?? empty,
      item.safeAfter ?? item.safeBefore ?? empty,
    );
    expect(
      quiet.map((finding) => finding.code),
      item.code,
    ).not.toContain(item.code);
    const allowed = lintSql(
      `-- okm-allow ${item.code}: reviewed\n${item.fire}`,
      item.before ?? empty,
      item.after ?? item.before ?? empty,
    );
    expect(
      allowed.map((finding) => finding.code),
      item.code,
    ).not.toContain(item.code);
    expect(
      allowed.map((finding) => finding.code),
      item.code,
    ).not.toContain("OKM1510");
    const blank = lintSql(
      `-- okm-allow ${item.code}:\n${item.fire}`,
      item.before ?? empty,
      item.after ?? item.before ?? empty,
    );
    expect(
      blank.map((finding) => finding.code),
      item.code,
    ).toContain(item.code);
    expect(
      blank.map((finding) => finding.code),
      item.code,
    ).toContain("OKM1510");
    const unusedCode = item.code === "OKM1511" ? "OKM1542" : "OKM1511";
    const unused = lintSql(
      `-- okm-allow ${unusedCode}: not this statement\n${item.fire}`,
      item.before ?? empty,
      item.after ?? item.before ?? empty,
    );
    expect(
      unused.map((finding) => finding.code),
      item.code,
    ).toContain(item.code);
    expect(formatFindings(unused), item.code).toContain(`override ${unusedCode} does not match`);
  }
  expect(labeled.objects.some((object) => object.kind === "type")).toBe(true);
});

test("OKM1538 follows the heap rewrite and stays quiet when Postgres does not rewrite", () => {
  const pair = (before: AnyTable, after: AnyTable): readonly string[] => codes(diff(before, after));
  const col = <C extends object>(column: C): AnyTable => table("tasks", { title: column });
  expect(pair(col(t.varchar(10)), col(t.varchar(20)))).not.toContain("OKM1538");
  expect(pair(col(t.varchar(10)), col(t.text()))).not.toContain("OKM1538");
  expect(pair(col(t.text()), col(t.custom(pass("character varying"))))).not.toContain("OKM1538");
  expect(pair(col(t.varchar(10)), col(t.custom(pass("character varying"))))).not.toContain(
    "OKM1538",
  );
  expect(pair(col(t.text()), col(t.custom(pass("bpchar"))))).not.toContain("OKM1538");
  expect(pair(col(t.varchar(10)), col(t.custom(pass("bpchar"))))).not.toContain("OKM1538");
  expect(pair(col(t.numeric(6, 2)), col(t.numeric(10, 2)))).not.toContain("OKM1538");
  expect(pair(col(t.numeric(6, 2)), col(t.numeric(10, 2)))).toContain("OKM1524");
  const unconstrained = pair(col(t.numeric(6, 2)), col(t.numeric()));
  expect(unconstrained).not.toContain("OKM1538");
  expect(unconstrained).toContain("OKM1533");
  expect(pair(col(t.integer()), col(t.custom(pass("oid"))))).not.toContain("OKM1538");
  expect(pair(col(t.custom(pass("oid"))), col(t.integer()))).not.toContain("OKM1538");
  expect(pair(col(t.cidr()), col(t.inet()))).not.toContain("OKM1538");
  expect(pair(col(t.custom(pass("xml"))), col(t.text()))).not.toContain("OKM1538");
  expect(pair(col(t.integer()), col(t.bigint()))).toContain("OKM1538");
  expect(pair(col(t.varchar(20)), col(t.varchar(10)))).toEqual(["OKM1527", "OKM1538"]);
  expect(pair(col(t.char(3)), col(t.char(8)))).toEqual(["OKM1538"]);
  expect(pair(col(t.timestamp()), col(t.timestamptz()))).toContain("OKM1538");
  expect(pair(col(t.inet()), col(t.cidr()))).toContain("OKM1538");

  const plain = castCodes("title::character varying(20)");
  expect(plain).not.toContain("OKM1538");
  const expression = castCodes("length(title)");
  expect(expression).toContain("OKM1538");

  const base = schema({ tables: [table("tasks", { n: t.integer() })] }).catalog;
  const domain = schema({
    tables: [table("tasks", { n: t.domain("plain_int", t.integer(), "((VALUE > 0))") })],
  }).catalog;
  const open = clearCheck(domain, "plain_int");
  expect(handType(base, open, "plain_int")).not.toContain("OKM1538");
  expect(handType(base, domain, "plain_int")).toContain("OKM1538");
  expect(handType(domain, base, "integer")).not.toContain("OKM1538");
});

test("OKM1552 compares a stored domain check and a LANGUAGE sql body", () => {
  const declared = schema({
    tables: [table("tasks", { n: t.domain("pos", t.integer(), "VALUE > 0") })],
    functions: [
      fn("by_id", {
        arguments: [{ name: "n", type: "text" }],
        returns: "text",
        language: "sql",
        body: "begin atomic select title from tasks where id = n; end",
      }),
    ],
  }).catalog;
  const stored = patchReprint(declared);
  const steps = planMigration({
    before: schema({ tables: [] }).catalog,
    after: declared,
    name: "reprint",
  }).steps;
  const hits = reprintHits(declared, stored, steps);
  expect(hits.map((hit) => hit.code)).toEqual(["OKM1552", "OKM1552"]);
  expect(hits.every((hit) => hit.severity === "warning")).toBe(true);
  expect(hits.map((hit) => hit.reason)).toEqual([
    "domain pos check reprints differently",
    "function by_id body reprints differently",
  ]);
  expect(reprintHits(declared, declared, steps)).toEqual([]);

  const allowed = steps.map((step) =>
    step.sql.includes("pos") || step.sql.includes("by_id")
      ? { ...step, allows: [{ code: "OKM1552", reason: "reviewed" }] }
      : step,
  );
  expect(reprintHits(declared, stored, allowed)).toEqual([]);
  const blank = steps.map((step) =>
    step.sql.includes("domain") ? { ...step, allows: [{ code: "OKM1552", reason: " " }] } : step,
  );
  expect(reprintHits(declared, stored, blank).some((hit) => hit.code === "OKM1510")).toBe(true);
  const unused = steps.map((step) =>
    step.sql.includes("by_id")
      ? { ...step, allows: [{ code: "OKM1552", reason: "reviewed" }] }
      : step,
  );
  expect(
    reprintHits(declared, declared, unused).some(
      (hit) => hit.code === "OKM1510" && hit.reason.includes("OKM1552"),
    ),
  ).toBe(true);

  expect(
    codesOfHand("-- okm-allow OKM1552: reviewed\ncreate domain pos as integer check (value > 0)"),
  ).not.toContain("OKM1510");
  expect(codesOfHand("-- okm-allow OKM1552: reviewed\ncreate table tasks (id bigint)")).toContain(
    "OKM1510",
  );
  expect(
    codesOfHand("-- okm-allow OKM1552:\ncreate domain pos as integer check (value > 0)"),
  ).toContain("OKM1510");
});

type Fixture = {
  readonly code: string;
  readonly fire: string;
  readonly safe: string;
  readonly before?: Catalog;
  readonly after?: Catalog;
  readonly safeBefore?: Catalog;
  readonly safeAfter?: Catalog;
};

function lintSql(sql: string, before: Catalog, after: Catalog): readonly Finding[] {
  return lintPlan(parsePlan(`-- name: hand\n\n${sql}\n`), before, after);
}

function pass(sqlType: string): {
  readonly sqlType: string;
  readonly encode: (value: string) => string;
  readonly decode: (wire: string) => string;
} {
  return { sqlType, encode: (value) => value, decode: (wire) => wire };
}

function castCodes(using: string): readonly string[] {
  const before = schema({ tables: [table("tasks", { title: t.varchar(10) })] }).catalog;
  const after = schema({ tables: [table("tasks", { title: t.varchar(20) })] }).catalog;
  return lintSql(
    `alter table "tasks" alter column "title" type character varying(20) using ${using}`,
    before,
    after,
  ).map((item) => item.code);
}

function handType(before: Catalog, after: Catalog, typeName: string): readonly string[] {
  return lintSql(`alter table "tasks" alter column "n" type ${typeName}`, before, after).map(
    (item) => item.code,
  );
}

function clearCheck(source: Catalog, name: string): Catalog {
  return {
    ...source,
    objects: source.objects.map((object) => {
      if (
        object.kind !== "type" ||
        object.identity.name !== name ||
        !("check" in object.definition)
      ) {
        return object;
      }
      return { ...object, definition: { ...object.definition, check: "" } };
    }),
  };
}

function patchReprint(source: Catalog): Catalog {
  return {
    ...source,
    objects: source.objects.map((object) => {
      if (
        object.kind === "type" &&
        object.identity.name === "pos" &&
        "check" in object.definition
      ) {
        return { ...object, definition: { ...object.definition, check: "((VALUE > 0))" } };
      }
      if (object.kind === "function" && object.identity.name === "by_id") {
        return {
          ...object,
          definition: {
            ...object.definition,
            body: "BEGIN ATOMIC\n  SELECT title FROM tasks WHERE id = by_id.n;\nEND",
          },
        };
      }
      return object;
    }),
  };
}

function hand(sql: string): readonly Finding[] {
  const empty = schema({ tables: [] }).catalog;
  return lintPlan(parsePlan(`-- name: hand\n\n${sql}\n`), empty, empty);
}

function codesOfHand(sql: string): readonly string[] {
  return hand(sql).map((item) => item.code);
}

function fromEmpty(source: AnyTable | Built): Planned {
  if ("catalog" in source) return plans(schema({ tables: [] }), source);
  return plans(schema({ tables: [] }), schema({ tables: [source] }));
}

function diff(before: AnyTable, after: AnyTable): Planned {
  return plans(schema({ tables: [before] }), schema({ tables: [after] }));
}

function plans(before: Built, after: Built): Planned {
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    renames: schemaDeclarations(after).renames,
    name: "lint",
  });
  return {
    plan,
    before: before.catalog,
    after: after.catalog,
    findings: lintPlan(plan, before.catalog, after.catalog),
  };
}

function keptCatalog(source: AnyTable): Catalog {
  return schema({ tables: [source] }).catalog;
}

function codes(planned: Planned): readonly string[] {
  return planned.findings.map((item) => item.code);
}

function codesOf(planned: Planned, sql: string): readonly string[] {
  const index = planned.plan.steps.findIndex((step) => step.sql === sql);
  return planned.findings
    .filter((item) => item.place === `step ${String(index + 1)}`)
    .map((item) => item.code);
}

function hasErrorCode(planned: Planned, code: string): boolean {
  return planned.findings.some((item) => item.code === code && item.severity === "error");
}

function allow(planned: Planned, code: string, reason: string): Planned {
  const text = formatPlan(planned.plan).replace(
    /^(drop table .*)$/m,
    `-- okm-allow ${code}: ${reason}\n$1`,
  );
  const plan = parsePlan(text);
  return { ...planned, plan, findings: lintPlan(plan, planned.before, planned.after) };
}

function withColumn(
  source: Catalog,
  name: string,
  patch: Partial<ColumnObject["definition"]>,
): Catalog {
  return {
    ...source,
    objects: source.objects.map((object) => {
      if (object.kind !== "column" || object.identity.name !== name) return object;
      return { ...object, definition: { ...object.definition, ...patch } };
    }),
  };
}

function writeMigration(directory: string, id: string, planned: Planned): void {
  writeFileSync(join(directory, "migrations", `${id}.sql`), formatPlan(planned.plan));
  writeFileSync(
    join(directory, "migrations", `${id}.catalog.json`),
    serializeCatalog(planned.after),
  );
}

function writeProject(cwd: string, root: string, tables: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      "export const app = schema({",
      `  tables: [${tables}],`,
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
      "",
    ].join("\n"),
  );
}

async function rejected(runCase: () => Promise<void>): Promise<OkmError> {
  try {
    await runCase();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
