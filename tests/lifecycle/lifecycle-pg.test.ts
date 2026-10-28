/**
 * Property: the migrate / push CLI contract holds over random schemas.
 *
 * PR tier: fixed seed, ~20 cases (`OKM_LIFECYCLE_CASES`, default 20).
 * Nightly: 300 cases and a printed random seed when `OKM_LIFECYCLE_SEED` is unset
 * and `OKM_LIFECYCLE_CASES=300`.
 *
 * Each case also draws a role, a start state, a namespace, and a project place.
 * It still ends at check ok, migrate check ok, generate with no changes, and
 * no scratch objects left behind.
 *
 * Only runs when `OKM_LIFECYCLE=1` so the ordinary Postgres suite stays fast.
 * Known open bugs are skipped by id; anything else fails with a copyable schema.
 */

import fc from "fast-check";
import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { OkmError } from "../../src/contracts/error.js";
import { schema, table, t } from "../../src/dialects/pg/index.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { formatLifecycleReport, knownSkipExceedsBudget, type LifecycleReport } from "./report.js";
import { runLifecycleCase } from "./run.js";
import {
  tagsFor,
  type ClashKind,
  type ColumnModel,
  type Evolution,
  type HostileRole,
  type HostileStart,
  type IndexModel,
  type LifecycleCase,
  type LifecycleCasing,
  type ProjectPlace,
  type SchemaModel,
} from "./model.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const ENABLED = process.env.OKM_LIFECYCLE === "1";
const CASES = Math.max(1, Number(process.env.OKM_LIFECYCLE_CASES ?? "20"));
const SEED = Number(
  process.env.OKM_LIFECYCLE_SEED ??
    (process.env.OKM_LIFECYCLE_RANDOM === "1"
      ? String((Math.random() * 0x100000000) >>> 0)
      : "20261024"),
);

if (ENABLED) {
  console.log(
    `[lifecycle] seed=${String(SEED)} cases=${String(CASES)} (set OKM_LIFECYCLE_SEED to replay)`,
  );
}

postgresTest(
  gate,
  "random migration lifecycle keeps generate/check/apply/push invariants",
  async () => {
    if (!ENABLED) {
      console.warn("[lifecycle] skipped (set OKM_LIFECYCLE=1 to run)");
      return;
    }
    const started = Date.now();
    const report: { ran: number; passed: number; known: number; unknown: number } = {
      ran: 0,
      passed: 0,
      known: 0,
      unknown: 0,
    };
    let lastUnknown: string | undefined;
    const finish = (): LifecycleReport => report;
    try {
      await fc.assert(
        fc.asyncProperty(lifecycleCaseArb, async (item) => {
          report.ran += 1;
          const outcome = await runLifecycleCase(root, item, SEED);
          if (outcome.ok) {
            report.passed += 1;
            return true;
          }
          if (outcome.known !== undefined) {
            report.known += 1;
            console.warn(`[lifecycle] skipped known ${outcome.known}`);
            return true;
          }
          report.unknown += 1;
          lastUnknown = outcome.error;
          // Throw so fast-check shrinks against the real message and the report
          // includes the copyable schema.
          throw new Error(outcome.error);
        }),
        {
          seed: SEED,
          numRuns: CASES,
          verbose: fc.VerbosityLevel.None,
          // Allow shrinks; stop early once a minimal unknown failure is in hand.
          endOnFailure: true,
          // Prefer structured shrink of the case over a long error string.
          includeErrorInReport: true,
        },
      );
    } catch (error) {
      const elapsedMs = Date.now() - started;
      console.log(`${formatLifecycleReport(finish())} elapsedMs=${String(elapsedMs)}`);
      if (lastUnknown !== undefined) {
        const lines = lastUnknown.split("\n").length;
        if (lines > 15) {
          throw new Error(
            `Lifecycle failure repro is ${String(lines)} lines (>15). Stop and ask.\n\n${lastUnknown}`,
          );
        }
      }
      throw error;
    }
    const elapsedMs = Date.now() - started;
    console.log(`${formatLifecycleReport(finish())} elapsedMs=${String(elapsedMs)}`);
    if (knownSkipExceedsBudget(finish())) {
      throw new Error(`${formatLifecycleReport(finish())}: known skips are more than 25% of cases`);
    }
    if (process.env.OKM_LIFECYCLE_TIER === "pr" && elapsedMs > 240_000) {
      throw new Error(
        `PR-tier lifecycle run exceeded 4 minutes (${String(elapsedMs)} ms). Stop and ask.`,
      );
    }
  },
  Math.max(180_000, CASES * 15_000),
);

postgresTest(
  gate,
  "a snake schema and a camel schema apply, and a collision or a long name is refused",
  async () => {
    const snake = await runLifecycleCase(
      root,
      plainCase("snake", "publishedNotes", "publishedAt"),
      1,
    );
    const camel = await runLifecycleCase(
      root,
      plainCase("camel", "published_notes", "published_at"),
      2,
    );
    expect(snake.ok).toBe(true);
    expect(camel.ok).toBe(true);
    if (!snake.ok) throw new Error(snake.error);
    if (!camel.ok) throw new Error(camel.error);

    const collision = refused(() =>
      schema({
        casing: "snake",
        tables: [table("notes", { userID: t.text(), user_id: t.text() })],
      }),
    );
    expect(collision.code).toBe("OKM1023");
    const longKey = `n${"x".repeat(63)}`;
    const long = refused(() =>
      schema({
        casing: "camel",
        tables: [table("notes", { [longKey]: t.text() })],
      }),
    );
    expect(long.code).toBe("OKM1122");
    expect(Buffer.byteLength(longKey)).toBeGreaterThan(63);
  },
  180_000,
);

postgresTest(
  gate,
  "seed 794248870 refuses a foreign okm_steps before the index step",
  async () => {
    await expectLifecycle(seed794248870(), 794248870);
  },
  180_000,
);

postgresTest(
  gate,
  "seed 3095607538 refuses a foreign okm_steps before the index step",
  async () => {
    await expectLifecycle(seed3095607538(), 3095607538);
  },
  180_000,
);

postgresTest(
  gate,
  "seed 2954186523 pushes a populated column drop with --allow-data-loss",
  async () => {
    await expectLifecycle(seed2954186523(), 2954186523);
  },
  180_000,
);

postgresTest(
  gate,
  "seed 3054527222 refuses a foreign okm_steps before the index step",
  async () => {
    await expectLifecycle(seed3054527222(), 3054527222);
  },
  180_000,
);

postgresTest(
  gate,
  "an empty column drop still pushes with no data-loss flag",
  async () => {
    await expectLifecycle(emptyDrop(), 17);
  },
  180_000,
);

async function expectLifecycle(item: LifecycleCase, seed: number): Promise<void> {
  const outcome = await runLifecycleCase(root, item, seed);
  if (!outcome.ok) throw new Error(outcome.error);
}

function seed794248870(): LifecycleCase {
  return tracked({
    casing: "camel",
    namespace: "appns",
    tenancy: false,
    name: "o'neil",
    columns: [identity(), text("title"), domainWeight()],
    evolutions: [addIndex("title")],
    withRows: true,
    role: "owner",
    start: "clash",
    clash: "steps",
    place: "spaces",
  });
}

function seed3095607538(): LifecycleCase {
  return tracked({
    casing: "omit",
    namespace: "appns",
    tenancy: true,
    name: "notes",
    columns: [identity(), text("title"), integerN(), varcharExtra()],
    evolutions: [addIndex("title")],
    withRows: true,
    role: "owner",
    start: "clash",
    clash: "steps",
    place: "spaces",
  });
}

function seed2954186523(): LifecycleCase {
  return tracked({
    casing: "camel",
    namespace: "appns",
    tenancy: true,
    name: 'say "hi"',
    columns: [identity(), text("title"), colorStatus()],
    evolutions: [dropColumn("status"), addIndex("title")],
    withRows: false,
    role: "superuser",
    start: "rows",
    clash: "scratch",
    place: "symlink",
  });
}

function seed3054527222(): LifecycleCase {
  return tracked({
    casing: "omit",
    namespace: "appns",
    tenancy: true,
    name: "o'neil",
    columns: [identity(), text("title"), domainWeight()],
    evolutions: [dropColumn("weight"), addIndex("title")],
    withRows: false,
    role: "owner",
    start: "clash",
    clash: "steps",
    place: "spaces",
  });
}

function emptyDrop(): LifecycleCase {
  return tracked({
    casing: "omit",
    tenancy: false,
    name: "notes",
    columns: [identity(), text("title"), text("status")],
    evolutions: [dropColumn("status")],
    withRows: false,
    role: "owner",
    start: "empty",
    clash: "index",
    place: "plain",
  });
}

function tracked(input: {
  readonly casing: LifecycleCasing;
  readonly namespace?: string;
  readonly tenancy: boolean;
  readonly name: string;
  readonly columns: readonly ColumnModel[];
  readonly evolutions: readonly Evolution[];
  readonly withRows: boolean;
  readonly role: HostileRole;
  readonly start: HostileStart;
  readonly clash: ClashKind;
  readonly place: ProjectPlace;
}): LifecycleCase {
  const initial: SchemaModel = {
    casing: input.casing,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    tenancy: input.tenancy,
    trgm: false,
    tables: [
      {
        key: "tasks",
        name: input.name,
        columns: input.columns,
        indexes: [],
        checks: [],
        archive: false,
        versioned: false,
      },
    ],
    triggers: [],
    views: [],
  };
  const env = {
    role: input.role,
    start: input.start,
    clash: input.clash,
    place: input.place,
  };
  return {
    initial,
    evolutions: input.evolutions,
    withRows: input.withRows,
    ...env,
    tags: tagsFor(initial, input.evolutions, input.withRows, env),
  };
}

function identity(): ColumnModel {
  return {
    key: "id",
    name: "id",
    type: "identity",
    nullable: false,
    primaryKey: true,
    unique: false,
    defaultKind: "none",
  };
}

function text(key: string): ColumnModel {
  return {
    key,
    name: key,
    type: "text",
    nullable: false,
    primaryKey: false,
    unique: false,
    defaultKind: "none",
  };
}

function integerN(): ColumnModel {
  return {
    key: "n",
    name: "n",
    type: "integer",
    nullable: true,
    primaryKey: false,
    unique: false,
    defaultKind: "constant",
    defaultValue: "0",
  };
}

function varcharExtra(): ColumnModel {
  return {
    key: "extra",
    name: "extra",
    type: "varchar",
    nullable: true,
    primaryKey: false,
    unique: false,
    defaultKind: "none",
  };
}

function domainWeight(): ColumnModel {
  return {
    key: "weight",
    name: "weight",
    type: "domain",
    nullable: false,
    primaryKey: false,
    unique: false,
    defaultKind: "none",
    domainName: "pos",
    domainCheck: "VALUE > 0",
  };
}

function colorStatus(): ColumnModel {
  return {
    key: "status",
    name: "status",
    type: "enum",
    nullable: false,
    primaryKey: false,
    unique: false,
    defaultKind: "constant",
    defaultValue: "red",
    enumName: "color",
    enumLabels: ["red", "blue"],
  };
}

function addIndex(column: string): Evolution {
  const index: IndexModel = { columns: [column], unique: false, usingTrgm: false };
  return { kind: "addIndex", tableKey: "tasks", index };
}

function dropColumn(columnKey: string): Evolution {
  return { kind: "dropColumn", tableKey: "tasks", columnKey };
}

function plainCase(casing: LifecycleCasing, tableName: string, columnName: string): LifecycleCase {
  const column = (key: string, type: ColumnModel["type"], primaryKey: boolean): ColumnModel => ({
    key,
    name: key,
    type,
    nullable: false,
    primaryKey,
    unique: false,
    defaultKind: "none",
  });
  const initial = {
    casing,
    tenancy: false,
    trgm: false,
    tables: [
      {
        key: "notes",
        name: tableName,
        columns: [column("id", "identity", true), column(columnName, "text", false)],
        indexes: [],
        checks: [],
        archive: false,
        versioned: false,
      },
    ],
    triggers: [],
    views: [],
  };
  const env = {
    role: "owner" as const,
    start: "empty" as const,
    clash: "index" as const,
    place: "plain" as const,
  };
  return {
    initial,
    evolutions: [],
    withRows: false,
    ...env,
    tags: tagsFor(initial, [], false, env),
  };
}

function refused(body: () => unknown): OkmError {
  try {
    body();
  } catch (error) {
    return OkmError.from(error);
  }
  throw new Error("expected a rejection");
}
