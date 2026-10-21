/**
 * Offline bad/fixed pairs for error pages.
 *
 * A pair runs without a server. Codes that need Postgres are listed in
 * {@link NEEDS_DATABASE}. Codes this build does not throw are
 * {@link NOT_THROWN}.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { outcomeUnknown } from "../../adapters/error.js";
import {
  catalog as buildCatalog,
  parseCatalog,
  serializeCatalog,
} from "../../contracts/catalog/document.js";
import type { Catalog, ColumnObject } from "../../contracts/catalog/types.js";
import type { DriverPool } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import {
  column as catalogColumn,
  staticNamespace,
  table as catalogTable,
} from "../../contracts/internal.js";
import { decodeBigintNumber } from "../../dialects/pg/integer.js";
import { mapPostgresError } from "../../dialects/pg/errors.js";
import { schemaDeclarations } from "../../dialects/pg/declarations.js";
import { enumColumn } from "../../dialects/pg/enum.js";
import { extension } from "../../dialects/pg/ext/index.js";
import { fn } from "../../dialects/pg/fn/index.js";
import {
  fragment,
  id,
  ident,
  index,
  many,
  or,
  raw,
  schema,
  table,
  t,
  text,
} from "../../dialects/pg/index.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import { materializedView, view } from "../../dialects/pg/view/index.js";
import { connect } from "../../runtime/pg/postgresjs.js";
import { archivable, timestamps, trait } from "../../runtime/traits/index.js";
import { columnTenancy, global } from "../../runtime/tenancy/index.js";
import { refuseMissingValidation } from "../../runtime/validate/closed.js";
import { assertValidation } from "../../runtime/validate/places.js";
import { stand } from "../../runtime/validate/engine.js";
import { v } from "../../runtime/validate/rules.js";
import { assertParamCount, PG_PARAM_LIMIT } from "../../runtime/param-limit.js";
import { assertSupported } from "../capabilities/check.js";
import type { Registry } from "../capabilities/types.js";
import { primaryKeyColumns } from "../migrate/backfill.js";
import { lintCatalog, lintPlan, type Finding } from "../migrate/lint.js";
import { parsePlan, planMigration } from "../migrate/plan.js";
import {
  assertStableBackend,
  assertTargetAlias,
  assertTargetPolicy,
  listTargets,
  selectTarget,
} from "../migrate/policy.js";
import { checkProject } from "../migrate/project.js";
import { parseReplace } from "../migrate/values.js";
import { reprintHits } from "../migrate/reprint.js";
import {
  refuseDifferentDriver,
  refuseMissingDecision,
  refusePlanHash,
  refuseTenancy,
  refuseUnsupported,
  refuseUserModified,
} from "../init/guards.js";
import { resumeCommittedStep, stepSqlHash } from "../migrate/step-engine.js";
import type { CommittedStep, StepEngine, StepJournal } from "../migrate/step-engine.js";
import type { PageExample } from "./page.js";

/** Codes whose producer reads a live server. */
export const NEEDS_DATABASE = [
  "OKM1520",
  "OKM1521",
  "OKM1522",
  "OKM1707",
  "OKM1708",
  "OKM1801",
  "OKM1802",
  "OKM1803",
  "OKM1811",
  "OKM1814",
  "OKM1821",
  "OKM1825",
  "OKM1547",
  "OKM1548",
  "OKM1549",
  "OKM1841",
  "OKM1842",
  "OKM1843",
  "OKM1844",
  "OKM1846",
  "OKM1851",
  "OKM1855",
  "OKM1856",
  "OKM1857",
  "OKM1858",
  "OKM1554",
  "OKM1555",
] as const;

/**
 * Registered codes this build does not throw.
 *
 * OKM1025 is a second `Register` augmentation. OKM1051, OKM1110, OKM1191,
 * and OKM1601 have no raising path.
 */
export const NOT_THROWN = ["OKM1025", "OKM1051", "OKM1110", "OKM1191", "OKM1601"] as const;

/** One offline pair. `bad` and `fixed` are the source the page prints. */
export type OfflineExample = {
  readonly bad: string;
  readonly fixed: string;
  readonly check: () => Promise<void> | void;
};

const pairs = new Map<string, OfflineExample>();

/**
 * Example the page generator writes for `code`.
 *
 * @param code - Spec code
 * @returns The pair, the database sentence, or `undefined` when the code is not thrown
 */
export function pageExample(code: string): PageExample | undefined {
  if ((NEEDS_DATABASE as readonly string[]).includes(code)) return { kind: "database" };
  const pair = pairs.get(code);
  if (pair === undefined) return undefined;
  return { kind: "pair", bad: pair.bad, fixed: pair.fixed };
}

/**
 * Offline pair for `code`, when one exists.
 *
 * @param code - Spec code
 * @returns The pair, or `undefined`
 */
export function offlineExample(code: string): OfflineExample | undefined {
  return pairs.get(code);
}

const empty = schema({ tables: [] }).catalog;
const notesTable = () => table("notes", { id: t.identity(), title: t.text() });
const notesCatalog = schema({ tables: [notesTable()] }).catalog;

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

function thrown(code: string, bad: () => unknown, fixed: () => unknown): void {
  pairs.set(code, {
    bad: sourceOf(bad),
    fixed: sourceOf(fixed),
    check: async () => {
      const got = await catchCode(bad);
      if (got !== code) throw new Error(`${code} bad produced ${got ?? "nothing"}`);
      const after = await catchCode(fixed);
      if (after === code) throw new Error(`${code} fixed still produces it`);
    },
  });
}

function reported(
  code: string,
  bad: () => readonly string[],
  fixed: () => readonly string[],
): void {
  pairs.set(code, {
    bad: sourceOf(bad),
    fixed: sourceOf(fixed),
    check: () => {
      const got = bad();
      if (!got.includes(code))
        throw new Error(`${code} bad reported ${got.join(", ") || "nothing"}`);
      if (fixed().includes(code)) throw new Error(`${code} fixed still reports it`);
    },
  });
}

function sourceOf(fn: () => unknown): string {
  return fn.toString().trim();
}

async function catchCode(run: () => unknown): Promise<string | undefined> {
  try {
    const value = run();
    if (value instanceof Promise) await value;
    return undefined;
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
}

function committedNote(): CommittedStep {
  const sql = "create table notes (id int)";
  return {
    migrationId: "0001_init",
    stepIndex: 0,
    kind: "create-table",
    sql,
    sqlHash: stepSqlHash(sql),
    stepClass: "create-table",
    catalogHash: "catalog",
    finishes: false,
  };
}

function failedMarker(sqlHash: string): StepJournal {
  const step = committedNote();
  return {
    read: () =>
      Promise.resolve({
        migrationId: step.migrationId,
        stepIndex: step.stepIndex,
        kind: step.kind,
        sqlHash,
        state: "failed",
        attempt: 1,
      }),
    start: () => Promise.resolve(),
    fail: () => Promise.resolve(),
    complete: () => Promise.resolve(),
  };
}

function unknownEngine(): StepEngine {
  return {
    probed: true,
    probe: () => Promise.resolve("unknown"),
    cleanup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  };
}

function appliedEngine(): StepEngine {
  return {
    probed: true,
    probe: () => Promise.resolve("applied"),
    cleanup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  };
}

function hand(sql: string, before: Catalog = empty): readonly string[] {
  return lintPlan(parsePlan(`-- class: contract\n\n${sql}\n`), before, before).map(
    (item) => item.code,
  );
}

function diffCodes(before: AnyTable, after: AnyTable): readonly string[] {
  const left = schema({ tables: [before] });
  const right = schema({ tables: [after] });
  const plan = planMigration({ before: left.catalog, after: right.catalog, name: "example" });
  return lintPlan(plan, left.catalog, right.catalog).map((item: Finding) => item.code);
}

function schemaCodes(
  before: ReturnType<typeof schema>,
  after: ReturnType<typeof schema>,
): readonly string[] {
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "example" });
  return lintPlan(plan, before.catalog, after.catalog).map((item) => item.code);
}

thrown(
  "OKM1012",
  () =>
    schema({
      traits: [timestamps()],
      tables: [table("notes", { id: t.text().primaryKey(), createdAt: t.text() })],
    }).catalog,
  () =>
    schema({
      traits: [timestamps()],
      tables: [table("notes", { id: t.text().primaryKey() })],
    }).catalog,
);

thrown(
  "OKM1020",
  () => {
    return schema({ tables: [table("notes", { email: t.citext() })] }).catalog;
  },
  () => {
    return schema({
      tables: [table("notes", { email: t.text() })],
    }).catalog;
  },
);

thrown(
  "OKM1023",
  () => {
    return schema({
      tables: [
        table("notes", { id: t.text().primaryKey() }),
        table("notes", { id: t.text().primaryKey() }),
      ],
    }).catalog;
  },
  () => {
    return schema({
      tables: [
        table("notes", { id: t.text().primaryKey() }),
        table("tasks", { id: t.text().primaryKey() }),
      ],
    }).catalog;
  },
);

thrown(
  "OKM1027",
  () => {
    parseCatalog("{");
  },
  () => {
    parseCatalog(serializeCatalog(empty));
  },
);

thrown(
  "OKM1040",
  () => {
    trait("bad", { fields: {}, presets: { find: (query: never) => query } as never });
  },
  () => {
    trait("labeled", { fields: { label: t.text() } });
  },
);

thrown(
  "OKM1060",
  () => {
    t.domain("pos", t.integer(), "");
  },
  () => {
    t.domain("pos", t.integer(), "((VALUE > 0))");
  },
);

thrown(
  "OKM1061",
  () => {
    archivable({ strategy: "table" });
  },
  () => {
    archivable();
  },
);

thrown(
  "OKM1126",
  () => {
    assertParamCount(PG_PARAM_LIMIT + 1);
  },
  () => {
    assertParamCount(1);
  },
);

thrown(
  "OKM1201",
  () => {
    refuseMissingValidation();
  },
  () => {
    return schema({ tables: [table("notes", { id: t.text().primaryKey() })] }).catalog;
  },
);

thrown(
  "OKM1401",
  () => {
    throw mapPostgresError(outcomeUnknown());
  },
  () => {
    throw mapPostgresError(new OkmError("invalid", "not a lost commit"));
  },
);

thrown(
  "OKM1541",
  () => {
    parseReplace("nope");
  },
  () => {
    parseReplace("notes.title.old=new");
  },
);

thrown(
  "OKM1546",
  () => {
    primaryKeyColumns([schema({ tables: [table("notes", { title: t.text() })] }).catalog], "notes");
  },
  () => {
    primaryKeyColumns([notesCatalog], "notes");
  },
);

thrown(
  "OKM1812",
  () => {
    schema({
      requires: { postgres: ">=17" },
      tables: [table("users", { id: id({ default: "uuidv7" }), name: text() })],
    });
  },
  () => {
    schema({
      requires: { postgres: ">=18" },
      tables: [table("users", { id: id({ default: "uuidv7" }), name: text() })],
    });
  },
);

thrown(
  "OKM1813",
  () =>
    schema({
      tables: [table("notes", { id: t.text().primaryKey() })],
      extensions: [extension("citext"), extension("citext")],
    }).catalog,
  () =>
    schema({
      tables: [table("notes", { id: t.text().primaryKey() })],
      extensions: [extension("citext")],
    }).catalog,
);

thrown(
  "OKM1822",
  () => {
    materializedView("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from notes",
      refresh: "concurrently",
    });
  },
  () => {
    materializedView("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from notes",
    });
  },
);

thrown(
  "OKM1823",
  () => {
    fn("read", { returns: "integer", language: "sql", security: "definer", body: "select 1" });
  },
  () => {
    fn("read", {
      returns: "integer",
      language: "sql",
      security: "definer",
      body: "select 1",
      searchPath: "public",
    });
  },
);

thrown(
  "OKM1824",
  () => {
    fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end" });
  },
  () => {
    fn("touch", {
      returns: "trigger",
      language: "plpgsql",
      body: "begin return new; end",
      dependsOn: [],
    });
  },
);

thrown(
  "OKM1850",
  () => {
    assertTargetPolicy({ name: "default", protected: true }, "push", false);
  },
  () => {
    assertTargetPolicy({ name: "default", protected: true }, "check", false);
  },
);

thrown(
  "OKM1859",
  () => {
    assertTargetPolicy({ name: "default", protected: true, protection: "store" }, "push", true, {
      tty: false,
    });
  },
  () => {
    assertTargetPolicy({ name: "default", protected: true, protection: "store" }, "push", true, {
      tty: true,
    });
  },
);

thrown(
  "OKM1853",
  () => {
    selectTarget(
      {
        schema: "schema.ts",
        targets: {
          a: "postgres://localhost:5432/app",
          b: "postgres://localhost:5432/other",
        },
      },
      undefined,
    );
  },
  () => {
    selectTarget(
      {
        schema: "schema.ts",
        targets: {
          a: "postgres://localhost:5432/app",
          b: "postgres://localhost:5432/other",
        },
      },
      "a",
    );
  },
);

thrown(
  "OKM1845",
  () => {
    selectTarget({ schema: "schema.ts" }, undefined);
  },
  () => {
    selectTarget({ schema: "schema.ts", database: "postgres://localhost:5432/app" }, undefined);
  },
);

thrown(
  "OKM1852",
  () => {
    assertTargetAlias(
      listTargets({
        schema: "schema.ts",
        targets: {
          a: { url: "postgres://localhost:5432/app", protected: true },
          b: { url: "postgres://localhost:5432/app" },
        },
      }),
    );
  },
  () => {
    assertTargetAlias(
      listTargets({
        schema: "schema.ts",
        targets: {
          a: { url: "postgres://localhost:5432/app", protected: true },
          b: { url: "postgres://localhost:5432/app", protected: true },
        },
      }),
    );
  },
);

thrown(
  "OKM1854",
  async () => {
    let n = 0;
    await assertStableBackend(async () => {
      n += 1;
      return n < 2 ? "1" : "2";
    }, false);
  },
  async () => {
    await assertStableBackend(async () => "1", false);
  },
);

thrown(
  "OKM1860",
  () => {
    const registry: Registry = {
      "schema.core": {
        support: "refused",
        proof: "proof",
        alternative: "Use a table this dialect can create.",
        code: "OKM1860",
      },
    };
    assertSupported(["schema.core"], registry, "sqlite");
  },
  () => {
    const registry: Registry = {
      "schema.core": { support: "native", proof: "proof" },
    };
    assertSupported(["schema.core"], registry, "sqlite");
  },
);

const tasks = () => table("tasks", { id: t.identity(), title: t.text() });

reported(
  "OKM1511",
  () =>
    schemaCodes(schema({ tables: [tasks(), notesTable()] }), schema({ tables: [notesTable()] })),
  () => schemaCodes(schema({ tables: [] }), schema({ tables: [notesTable()] })),
);

reported(
  "OKM1512",
  () => diffCodes(tasks(), table("tasks", { id: t.identity() })),
  () => diffCodes(tasks(), tasks()),
);

reported(
  "OKM1513",
  () =>
    diffCodes(
      table("tasks", { id: t.identity(), status: enumColumn("color", ["red", "blue"]) }),
      table("tasks", { id: t.identity() }),
    ),
  () =>
    diffCodes(
      table("tasks", { id: t.identity() }),
      table("tasks", { id: t.identity(), status: enumColumn("color", ["red", "blue"]) }),
    ),
);

reported(
  "OKM1514",
  () =>
    diffCodes(
      table("tasks", {
        id: t.identity(),
        name: t.domain("label", t.text(), "((length(VALUE) > 0))"),
      }),
      table("tasks", { id: t.identity() }),
    ),
  () =>
    diffCodes(
      table("tasks", { id: t.identity() }),
      table("tasks", {
        id: t.identity(),
        name: t.domain("label", t.text(), "((length(VALUE) > 0))"),
      }),
    ),
);

reported(
  "OKM1515",
  () => {
    const answer = fn("answer", { returns: "integer", language: "sql", body: "select 1" });
    return schemaCodes(
      schema({ tables: [tasks()], functions: [answer] }),
      schema({ tables: [tasks()] }),
    );
  },
  () => {
    const answer = fn("answer", { returns: "integer", language: "sql", body: "select 1" });
    return schemaCodes(schema({ tables: [] }), schema({ tables: [tasks()], functions: [answer] }));
  },
);

reported(
  "OKM1516",
  () => {
    const listed = view("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from tasks",
    });
    return schemaCodes(
      schema({ tables: [tasks()], views: [listed] }),
      schema({ tables: [tasks()] }),
    );
  },
  () => {
    const listed = view("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from tasks",
    });
    return schemaCodes(schema({ tables: [] }), schema({ tables: [tasks()], views: [listed] }));
  },
);

reported(
  "OKM1517",
  () =>
    schemaCodes(
      schema({ tables: [tasks()], extensions: [extension("pgcrypto")] }),
      schema({ tables: [tasks()] }),
    ),
  () =>
    schemaCodes(
      schema({ tables: [] }),
      schema({ tables: [tasks()], extensions: [extension("pgcrypto")] }),
    ),
);

reported(
  "OKM1518",
  () => {
    const stored = materializedView("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from tasks",
    });
    return schemaCodes(
      schema({ tables: [tasks()], views: [stored] }),
      schema({ tables: [tasks()] }),
    );
  },
  () => {
    const stored = materializedView("titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from tasks",
    });
    return schemaCodes(schema({ tables: [] }), schema({ tables: [tasks()], views: [stored] }));
  },
);

reported(
  "OKM1510",
  () => hand("-- okm-allow OKM1511:\ndrop table notes"),
  () => hand("create table notes (id int)"),
);

reported(
  "OKM1542",
  () => hand("insert into notes (title) values ('a')"),
  () => hand("create table notes (id int)"),
);

reported(
  "OKM1550",
  () => hand("alter table notes disable row level security"),
  () => hand("create table notes (id int)"),
);

reported(
  "OKM1551",
  () => hand("commit"),
  () => hand("create table notes (id int)"),
);

thrown(
  "OKM1553",
  () =>
    resumeCommittedStep(committedNote(), failedMarker(committedNote().sqlHash), unknownEngine(), {
      retries: 0,
      wrap: (error) => error as OkmError,
    }),
  () =>
    resumeCommittedStep(committedNote(), failedMarker(committedNote().sqlHash), appliedEngine(), {
      retries: 0,
      wrap: (error) => error as OkmError,
    }),
);

thrown(
  "OKM1556",
  () =>
    resumeCommittedStep(
      committedNote(),
      failedMarker(stepSqlHash("create table other (id int)")),
      appliedEngine(),
      {
        retries: 0,
        wrap: (error) => error as OkmError,
      },
    ),
  () =>
    resumeCommittedStep(committedNote(), failedMarker(committedNote().sqlHash), appliedEngine(), {
      retries: 0,
      wrap: (error) => error as OkmError,
    }),
);

reported(
  "OKM1525",
  () => hand("alter table notes add column extra text not null", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

reported(
  "OKM1526",
  () => hand("alter table notes alter column title drop default", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

reported(
  "OKM1529",
  () => hand("create unique index notes_title on notes (title)", notesCatalog),
  () => hand("create index notes_title on notes (title)", notesCatalog),
);

reported(
  "OKM1534",
  () => hand("create index notes_title on notes (title)", notesCatalog),
  () => hand("create index concurrently notes_title on notes (title)", notesCatalog),
);

reported(
  "OKM1539",
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), at: t.timestamp() })] }).catalog,
    ).map((item) => item.code),
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), at: t.timestamptz() })] }).catalog,
    ).map((item) => item.code),
);

reported(
  "OKM1540",
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), name: t.varchar(20) })] }).catalog,
    ).map((item) => item.code),
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), name: t.text() })] }).catalog,
    ).map((item) => item.code),
);

reported(
  "OKM1544",
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), body: t.json() })] }).catalog,
    ).map((item) => item.code),
  () =>
    lintCatalog(
      schema({ tables: [table("tasks", { id: t.identity(), body: t.jsonb() })] }).catalog,
    ).map((item) => item.code),
);

reported(
  "OKM1543",
  () =>
    lintCatalog(
      withColumn(schema({ tables: [tasks()] }).catalog, "title", {
        dataType: "int4",
        defaultExpression: "nextval('tasks_title_seq'::regclass)",
      }),
    ).map((item) => item.code),
  () => lintCatalog(schema({ tables: [tasks()] }).catalog).map((item) => item.code),
);

reported(
  "OKM1545",
  () =>
    lintCatalog(
      withColumn(schema({ tables: [tasks()] }).catalog, "id", { identity: { always: false } }),
    ).map((item) => item.code),
  () => lintCatalog(schema({ tables: [tasks()] }).catalog).map((item) => item.code),
);

reported(
  "OKM1552",
  () => {
    const declared = schema({
      tables: [table("tasks", { n: t.domain("pos", t.integer(), "VALUE > 0") })],
    }).catalog;
    const stored = {
      ...declared,
      objects: declared.objects.map((object) => {
        if (
          object.kind === "type" &&
          object.identity.name === "pos" &&
          "check" in object.definition
        ) {
          return { ...object, definition: { ...object.definition, check: "((VALUE > 0))" } };
        }
        return object;
      }),
    };
    const steps = planMigration({ before: empty, after: declared, name: "reprint" }).steps;
    return reprintHits(declared, stored, steps).map((item) => item.code);
  },
  () => {
    const declared = schema({
      tables: [table("tasks", { n: t.domain("pos", t.integer(), "VALUE > 0") })],
    }).catalog;
    const steps = planMigration({ before: empty, after: declared, name: "reprint" }).steps;
    return reprintHits(declared, declared, steps).map((item) => item.code);
  },
);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

function notesSchema() {
  return schema({ tables: [table("notes", { id: t.identity(), title: t.text() })] });
}

function notesClient() {
  return connect(pool, { schema: notesSchema() });
}

thrown(
  "OKM1021",
  () => {
    schema({
      tables: [
        table("users", { email: t.text() }),
        table("tasks", { ownerId: t.uuid().references("users") }),
      ],
    });
  },
  () => {
    schema({
      tables: [
        table("users", { id: t.uuid().primaryKey(), email: t.text() }),
        table("tasks", { ownerId: t.uuid().references("users") }),
      ],
    });
  },
);

thrown(
  "OKM1022",
  () => {
    schema({
      tables: [
        table("users", { id: t.id() }),
        table("tasks", { ownerId: t.integer().references("users") }),
      ],
    });
  },
  () => {
    schema({
      tables: [
        table("users", { id: t.id() }),
        table("tasks", { ownerId: t.uuid().references("users") }),
      ],
    });
  },
);

thrown(
  "OKM1024",
  () => checkProject(tableProject(true)),
  () => checkProject(tableProject(false)),
);

thrown(
  "OKM1026",
  () => {
    const provenance = { origin: "file" as const, name: "db/tasks.ts" };
    const ns = staticNamespace("public");
    const parent = { namespace: ns, name: "tasks" };
    const left = { kind: "column" as const, parent, name: "alpha" };
    const right = { kind: "column" as const, parent, name: "beta" };
    buildCatalog([
      catalogTable({ namespace: ns, name: "tasks", provenance }),
      catalogColumn({
        parent,
        name: "alpha",
        dataType: "text",
        nullable: false,
        provenance,
        dependencies: [right],
      }),
      catalogColumn({
        parent,
        name: "beta",
        dataType: "text",
        nullable: false,
        provenance,
        dependencies: [left],
      }),
    ]);
  },
  () => {
    const provenance = { origin: "file" as const, name: "db/tasks.ts" };
    const ns = staticNamespace("public");
    const parent = { namespace: ns, name: "tasks" };
    buildCatalog([
      catalogTable({ namespace: ns, name: "tasks", provenance }),
      catalogColumn({ parent, name: "id", dataType: "text", nullable: false, provenance }),
    ]);
  },
);

thrown(
  "OKM1030",
  () => {
    assertValidation(
      schema({
        tables: [
          table(
            "tasks",
            { title: text().validate([v.min(1, "title_required")]) },
            { validate: { title: [v.min(1, "title_required")] }, validation: true },
          ),
        ],
      }),
    );
  },
  () => {
    assertValidation(
      schema({
        tables: [table("tasks", { title: text().validate([v.min(1, "title_required")]) })],
      }),
    );
  },
);

thrown(
  "OKM1052",
  async () => {
    const db = connect(pool, {
      schema: schema({
        tables: [
          table("notes", { id: t.identity(), title: t.text() }),
          table("files", { id: t.identity() }, { traits: [archivable()] }),
        ],
      }),
    });
    const handle = db.notes as unknown as { archive(input: unknown): Promise<unknown> };
    await handle.archive({ where: { id: "1" } });
  },
  async () => {
    const db = connect(pool, {
      schema: schema({
        tables: [table("files", { id: t.identity() }, { traits: [archivable()] })],
      }),
    });
    const handle = db.files as unknown as { archive(input: unknown): Promise<unknown> };
    await handle.archive({ where: { id: "1" } });
  },
);

thrown(
  "OKM1101",
  async () => notesClient().notes.find({}),
  async () => notesClient().notes.find({ limit: 1 }),
);

thrown(
  "OKM1102",
  async () => {
    await notesClient().notes.delete({});
  },
  async () => {
    await notesClient().notes.delete({ where: { id: "1" } });
  },
);

thrown(
  "OKM1104",
  async () => {
    await notesClient().notes.insert({ title: "a" }, {
      onConflict: { on: "title", return: true },
    } as never);
  },
  async () => {
    await notesClient().notes.insert({ title: "a" }, {
      onConflict: { on: "id", return: true },
    } as never);
  },
);

thrown(
  "OKM1105",
  async () => {
    const comments = table("comments", {
      id: t.identity(),
      noteId: t.bigint().references("notes"),
      body: t.text(),
    });
    const notes = table(
      "notes",
      { id: t.identity(), title: t.text() },
      { relations: { comments: many("comments", "noteId") } },
    );
    const db = connect(pool, { schema: schema({ tables: [notes, comments] }) });
    await db.notes.find({ limit: 1, include: { comments: true } } as never);
  },
  async () => {
    const comments = table("comments", {
      id: t.identity(),
      noteId: t.bigint().references("notes"),
      body: t.text(),
    });
    const notes = table(
      "notes",
      { id: t.identity(), title: t.text() },
      { relations: { comments: many("comments", "noteId") } },
    );
    const db = connect(pool, { schema: schema({ tables: [notes, comments] }) });
    await db.notes.find({ limit: 1, include: { comments: { limit: 1 } } });
  },
);

thrown(
  "OKM1111",
  async () => {
    await notesClient().tx(async () => undefined);
  },
  async () => {
    await notesClient().notes.find({ limit: 1 });
  },
);

thrown(
  "OKM1120",
  async () => {
    await notesClient().notes.find({ limit: 1, where: { missing: "x" } as never });
  },
  async () => {
    await notesClient().notes.find({ limit: 1, where: { title: "x" } });
  },
);

thrown(
  "OKM1121",
  async () => {
    await notesClient().notes.find({ limit: 1, where: or([{}]) });
  },
  async () => {
    await notesClient().notes.find({ limit: 1, where: or([{ title: "a" }, { title: "b" }]) });
  },
);

thrown(
  "OKM1122",
  () => {
    ident("");
  },
  () => {
    ident("title");
  },
);

thrown(
  "OKM1123",
  () => {
    table("notes", { id: t.identity(), secret: t.text().hidden() }).filters({
      allow: { secret: ["eq"] },
    });
  },
  () => {
    table("notes", { id: t.identity(), title: t.text(), secret: t.text().hidden() }).filters({
      allow: { title: ["eq"] },
    });
  },
);

thrown(
  "OKM1124",
  async () => {
    await notesClient().notes.aggregate({ sum: ["title"] });
  },
  async () => {
    await notesClient().notes.aggregate({ count: true });
  },
);

thrown(
  "OKM1125",
  async () => {
    class Row {
      id = "";
    }
    await raw(notesClient().notes, Row, "read", fragment`select ${fragment.column} from notes`);
  },
  async () => {
    class Row {
      id = "";
    }
    await raw(notesClient().notes, Row, "read", fragment`select ${ident("id")} from notes`);
  },
);

thrown(
  "OKM1130",
  async () => {
    await notesClient().notes.page({ limit: 1, after: "not-a-cursor" });
  },
  async () => {
    await notesClient().notes.page({ limit: 1 });
  },
);

thrown(
  "OKM1190",
  async () => {
    const db = connect(pool, {
      schema: schema({
        tables: [
          table("notes", {
            id: t.text().primaryKey(),
            title: t.text(),
            role: t.text().guarded(),
          }),
        ],
      }),
    });
    await db.notes.insert({ id: "a", title: "g", role: "admin" } as never);
  },
  async () => {
    const db = connect(pool, {
      schema: schema({
        tables: [
          table("notes", {
            id: t.text().primaryKey(),
            title: t.text(),
            role: t.text().guarded(),
          }),
        ],
      }),
    });
    await db.notes.insert({ id: "a", title: "g" });
  },
);

thrown(
  "OKM1200",
  async () => {
    const tasks = table("tasks", { title: t.text().validate([v.min(1, "short")]) });
    const app = schema({ tables: [tasks], validation: true });
    await stand(app.model.tasks, tasks, true, "insert", { title: "" }, "valid");
  },
  async () => {
    const tasks = table("tasks", { title: t.text().validate([v.min(1, "short")]) });
    const app = schema({ tables: [tasks], validation: true });
    await stand(app.model.tasks, tasks, true, "insert", { title: "ok" }, "valid");
  },
);

thrown(
  "OKM1210",
  () => {
    decodeBigintNumber("nope");
  },
  () => {
    decodeBigintNumber("1");
  },
);

reported(
  "OKM1519",
  () => hand("alter table notes rename column title to name", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

reported(
  "OKM1523",
  () => hand("alter table notes rename to tasks", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

reported(
  "OKM1524",
  () => diffCodes(tasks(), table("tasks", { id: t.identity(), title: t.integer() })),
  () => diffCodes(tasks(), tasks()),
);

reported(
  "OKM1527",
  () =>
    diffCodes(
      table("tasks", { id: t.identity(), title: t.varchar(30) }),
      table("tasks", { id: t.identity(), title: t.varchar(20) }),
    ),
  () =>
    diffCodes(
      table("tasks", { id: t.identity(), title: t.varchar(20) }),
      table("tasks", { id: t.identity(), title: t.varchar(30) }),
    ),
);

reported(
  "OKM1528",
  () => hand("alter table notes add constraint notes_title unique (title)", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

thrown(
  "OKM1530",
  () => {
    planMigration({
      before: schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] }).catalog,
      after: schema({ tables: [table("tasks", { id: t.identity(), name: t.text() })] }).catalog,
      name: "example",
    });
  },
  () => {
    const after = schema({
      tables: [table("tasks", { id: t.identity(), name: t.text().renamedFrom("title") })],
    });
    planMigration({
      before: schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] }).catalog,
      after: after.catalog,
      renames: schemaDeclarations(after).renames,
      name: "example",
    });
  },
);

reported(
  "OKM1531",
  () =>
    hand("alter table notes add constraint notes_title check (length(title) > 0)", notesCatalog),
  () =>
    hand(
      "alter table notes add constraint notes_title check (length(title) > 0) not valid",
      notesCatalog,
    ),
);

reported(
  "OKM1532",
  () =>
    hand(
      "alter table notes add constraint notes_owner foreign key (title) references people (id)",
      notesCatalog,
    ),
  () =>
    hand(
      "alter table notes add constraint notes_owner foreign key (title) references people (id) not valid",
      notesCatalog,
    ),
);

reported(
  "OKM1533",
  () =>
    diffCodes(
      table("tasks", { id: t.identity(), n: t.bigint() }),
      table("tasks", { id: t.identity(), n: t.integer() }),
    ),
  () =>
    diffCodes(
      table("tasks", { id: t.identity(), n: t.integer() }),
      table("tasks", { id: t.identity(), n: t.bigint() }),
    ),
);

reported(
  "OKM1535",
  () =>
    hand("alter table notes add constraint notes_title check (length(title) > 0)", notesCatalog),
  () =>
    hand(
      "alter table notes add constraint notes_title check (length(title) > 0) not valid",
      notesCatalog,
    ),
);

reported(
  "OKM1536",
  () =>
    hand(
      "alter table notes add constraint notes_owner foreign key (title) references people (id)",
      notesCatalog,
    ),
  () =>
    hand(
      "alter table notes add constraint notes_owner foreign key (title) references people (id) not valid",
      notesCatalog,
    ),
);

reported(
  "OKM1537",
  () => hand("alter table notes alter column title set not null", notesCatalog),
  () => hand("alter table notes add column extra text", notesCatalog),
);

reported(
  "OKM1538",
  () => diffCodes(tasks(), table("tasks", { id: t.identity(), title: t.integer() })),
  () => diffCodes(tasks(), tasks()),
);

thrown(
  "OKM1602",
  async () => {
    class Row {
      id = "";
    }
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [notesTable()],
      }),
    });
    await raw(db.for({ tenantId: TENANT }).notes, Row, "read", "select 1");
  },
  async () => {
    class Row {
      id = "";
    }
    await raw(notesClient().notes, Row, "read", fragment`select ${ident("id")} from notes`);
  },
);

thrown(
  "OKM1701",
  async () => {
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    const root = db as unknown as {
      table(name: string): { find(input: object): Promise<unknown> };
    };
    await root.table("notes").find({ limit: 1 });
  },
  async () => {
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    await db.for({ tenantId: TENANT }).notes.find({ limit: 1 });
  },
);

thrown(
  "OKM1702",
  async () => {
    class Row {
      id = "";
    }
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    const scoped = db.for({ tenantId: TENANT });
    await raw(scoped.notes, Row, "read", fragment`select ${ident("title")} from notes`);
  },
  async () => {
    class Row {
      id = "";
    }
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    const scoped = db.for({ tenantId: TENANT });
    await raw(scoped.notes, Row, "read", fragment`select ${ident("id")} from notes`);
  },
);

thrown(
  "OKM1704",
  async () => {
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    await db.for({ tenantId: TENANT }).notes.update({
      where: { id: "a" },
      set: { tenantId: TENANT } as never,
    });
  },
  async () => {
    const db = connect(pool, {
      schema: schema({
        tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
        tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
      }),
    });
    await db.for({ tenantId: TENANT }).notes.update({ where: { id: "a" }, set: { title: "n" } });
  },
);

thrown(
  "OKM1705",
  () => {
    schema({
      tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
      tables: [
        table("tasks", { id: t.text().primaryKey() }),
        table(
          "audit",
          { id: t.text().primaryKey(), taskId: t.uuid().references("tasks") },
          { tenancy: global("audit log") },
        ),
      ],
    });
  },
  () => {
    schema({
      tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
      tables: [
        table("tasks", { id: t.text().primaryKey() }),
        table("audit", { id: t.text().primaryKey() }, { tenancy: global("audit log") }),
      ],
    });
  },
);

thrown(
  "OKM1706",
  () => {
    schema({
      tenancy: columnTenancy({ key: "tenantId", type: "uuid", indexes: false }),
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    });
  },
  () => {
    schema({
      tenancy: columnTenancy({ key: "tenantId", type: "uuid", indexes: false }),
      tables: [table("notes", { id: t.identity(), title: t.text() })],
    });
  },
);

thrown(
  "OKM1810",
  () =>
    schema({
      tables: [table("people", { email: t.citext() })],
      extensions: [extension("pg_trgm")],
    }).catalog,
  () =>
    schema({
      tables: [table("people", { email: t.citext() })],
      extensions: [extension("citext")],
    }).catalog,
);

thrown(
  "OKM1820",
  () => {
    schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
      tables: [table("tasks", { id: t.identity(), title: t.text() })],
      views: [
        view("titles", {
          columns: [{ name: "title", type: "text" }],
          query: "select title from tasks",
        }),
      ],
    });
  },
  () => {
    schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
      tables: [table("tasks", { id: t.identity(), title: t.text() })],
      views: [
        view("titles", {
          columns: [
            { name: "tenant_id", type: "uuid" },
            { name: "title", type: "text" },
          ],
          query: "select tenant_id, title from tasks",
        }),
      ],
    });
  },
);

thrown(
  "OKM1830",
  async () => {
    await notesClient().notes.find({ limit: 1, lock: "update" });
  },
  async () => {
    await notesClient().notes.find({ limit: 1 });
  },
);

thrown(
  "OKM1840",
  async () => {
    await notesClient().notes.find({ limit: 1, lock: "update", route: "replica" } as never);
  },
  async () => {
    await notesClient().notes.find({ limit: 1 });
  },
);

function tableProject(extra: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-1024-"));
  const schemaPath = join(repoRoot, "src/dialects/pg/index.ts");
  const configPath = join(repoRoot, "src/tooling/migrate/config.ts");
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { schema, table, t } from ${JSON.stringify(schemaPath)};\nexport const app = schema({ tables: [table("notes", { id: t.identity() })] });\n`,
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `import { defineConfig } from ${JSON.stringify(configPath)};\nexport default defineConfig({ schema: "./schema.ts", tables: "./tables" });\n`,
  );
  mkdirSync(join(cwd, "tables"));
  writeFileSync(
    join(cwd, extra ? "tables/extra.ts" : "tables/notes.ts"),
    "export const listed = true;\n",
  );
  return cwd;
}

thrown(
  "OKM1862",
  () => {
    refuseDifferentDriver("postgresjs", "pg");
  },
  () => {
    refuseDifferentDriver("pg", "pg");
  },
);

thrown(
  "OKM1863",
  () => {
    refuseMissingDecision(["--driver"]);
  },
  () => {
    refuseMissingDecision([]);
  },
);

thrown(
  "OKM1864",
  () => {
    refuseUserModified(["db/schema.ts"]);
  },
  () => {
    refuseUserModified([]);
  },
);

thrown(
  "OKM1865",
  () => {
    refuseUnsupported("okm init needs a package.json in the project directory.");
  },
  () => {
    refuseUnsupported(undefined);
  },
);

thrown(
  "OKM1866",
  () => {
    refusePlanHash("aaaa", "bbbb");
  },
  () => {
    refusePlanHash("aaaa", "aaaa");
  },
);

thrown(
  "OKM1867",
  () => {
    refuseTenancy("schema");
  },
  () => {
    refuseTenancy("none");
  },
);

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
