/**
 * Linter rules, overrides, and the generate / plan / check / apply exits.
 *
 * A create from an empty catalog is the fixture history. It stays clean.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  ).toEqual(["OKM1527"]);
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
  expect(set).toContain("OKM1531");
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
  expect(shrunk).not.toContain("OKM1538");

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
    await run(["generate"], { cwd: dropDir, stdout: (text) => lines.push(text) });
    const generated = lines.join("");
    const sqlPath = generated.split("\n")[0] ?? "";
    expect(sqlPath.endsWith(".sql")).toBe(true);
    expect(generated).toContain("error OKM1511");

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
