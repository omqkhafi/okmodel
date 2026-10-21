/**
 * Resume state machine for a committed step.
 *
 * No database. A fake journal and a fake engine cover every marker state,
 * every probe result, a hash mismatch, and the three crash boundaries.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { COMMANDS, flagsFor } from "../src/tooling/cli/spec.js";
import { exitCodeForCode } from "../src/tooling/cli/outcome.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import {
  constraintDefinitionVerdict,
  indexDefinitionVerdict,
} from "../src/tooling/migrate/pg-probe.js";
import {
  PartialCleanupError,
  resumeCommittedStep,
  scrubErrorText,
  stepSqlHash,
  type CommittedStep,
  type MarkerState,
  type ProbeResult,
  type StepBoundary,
  type StepEngine,
  type StepJournal,
  type StepMarker,
} from "../src/tooling/migrate/step-engine.js";

const step: CommittedStep = {
  migrationId: "0001_init",
  stepIndex: 2,
  kind: "create-index",
  sql: "create index concurrently items_id_idx on items (id)",
  sqlHash: stepSqlHash("create index concurrently items_id_idx on items (id)"),
  stepClass: "expand",
  catalogHash: "hash",
  finishes: false,
};

test("the statement hash uses LF and trimmed text", () => {
  expect(stepSqlHash("  select 1\r\n")).toBe(stepSqlHash("select 1"));
  expect(stepSqlHash("select 1")).not.toBe(stepSqlHash("select 2"));
});

test("error text drops control characters and keeps 500 characters", () => {
  expect(scrubErrorText("a\u0000b\u0007c")).toBe("abc");
  expect(scrubErrorText("x".repeat(800)).length).toBe(500);
});

test("resolve has no skip flag", () => {
  const command = COMMANDS.find((item) => item.id === "migrate resolve");
  expect(command).toBeDefined();
  const names = flagsFor(command).map((flag) => flag.name);
  expect(names).not.toContain("skip");
  expect(names).toContain("applied");
  expect(names).toContain("retry");
  expect(names).toContain("accept-unverified");
  const unverified = flagsFor(command).find((flag) => flag.name === "accept-unverified");
  expect(unverified?.short).toBeUndefined();
  expect(() => parseCli(["migrate", "resolve", "0001_init:0", "--skip"])).toThrow(OkmError);
});

test("new step codes use the exit map", () => {
  expect(exitCodeForCode("OKM1553")).toBe(3);
  expect(exitCodeForCode("OKM1554")).toBe(1);
  expect(exitCodeForCode("OKM1555")).toBe(3);
  expect(exitCodeForCode("OKM1556")).toBe(1);
});

const probes = ["applied", "absent", "partial", "unknown"] as const;
const states = ["started", "failed", "retry"] as const;

for (const state of states) {
  for (const probe of probes) {
    test(`${state} and ${probe} follows the resume table`, async () => {
      const world = harness({ state, probe, probed: true });
      const run = resumeCommittedStep(step, world.journal, world.engine, {
        retries: 0,
        wrap: (error) => new OkmError("invalid", error instanceof Error ? error.message : "failed"),
      });
      if (state !== "retry" && probe === "unknown") {
        const error = await rejection(run);
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) expect(error.code).toBe("OKM1553");
        expect(world.calls).toEqual(["probe"]);
        expect(world.marker?.state).toBe(state);
        return;
      }
      await run;
      if (probe === "applied") {
        expect(world.calls).toEqual(["probe", "complete"]);
        expect(world.marker).toBeUndefined();
        expect(world.history).toBe(true);
        return;
      }
      if (probe === "partial") {
        expect(world.calls[0]).toBe("probe");
        expect(world.calls).toContain("cleanup");
        expect(world.calls).toContain("run");
      } else {
        expect(world.calls).toContain("run");
        expect(world.calls).not.toContain("cleanup");
      }
      expect(world.history).toBe(true);
      expect(world.marker).toBeUndefined();
    });
  }
}

test("no marker runs the step and does not probe", async () => {
  const world = harness({ probe: "absent", probed: true });
  await resumeCommittedStep(step, world.journal, world.engine, {
    retries: 0,
    wrap: () => new OkmError("invalid", "failed"),
  });
  expect(world.calls).toEqual(["start", "run", "complete"]);
  expect(world.history).toBe(true);
});

test("a hash mismatch refuses before SQL", async () => {
  const world = harness({
    state: "started",
    probe: "applied",
    probed: true,
    sqlHash: "different",
  });
  const error = await rejection(
    resumeCommittedStep(step, world.journal, world.engine, {
      retries: 0,
      wrap: () => new OkmError("invalid", "failed"),
    }),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) expect(error.code).toBe("OKM1556");
  expect(world.calls).toEqual([]);
});

test("retry with no probe runs the step", async () => {
  const world = harness({ state: "retry", probe: "unknown", probed: false });
  await resumeCommittedStep(step, world.journal, world.engine, {
    retries: 0,
    wrap: () => new OkmError("invalid", "failed"),
  });
  expect(world.calls).toEqual(["probe", "start", "run", "complete"]);
});

test("a failed run records failed and names the next apply", async () => {
  const world = harness({ probe: "absent", probed: true, runError: new Error("duplicate key") });
  const error = await rejection(
    resumeCommittedStep(step, world.journal, world.engine, {
      retries: 0,
      wrap: (caught) =>
        new OkmError(
          "invalid",
          `Migration ${step.migrationId} failed at step ${String(step.stepIndex + 1)}: ${caught instanceof Error ? caught.message : "failed"}`,
        ),
    }),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.message.startsWith("Migration 0001_init failed at step 3:")).toBe(true);
    expect(error.message).toContain("probe absent");
    expect(error.message).toContain("resume at step 3, probe, then run");
  }
  expect(world.marker?.state).toBe("failed");
  expect(world.marker?.attempt).toBe(1);
});

test("cleanup failure keeps the INVALID index text", async () => {
  const world = harness({
    probe: "partial",
    probed: true,
    runError: new Error("duplicate"),
    cleanupError: new PartialCleanupError(
      ' Index "items_id_idx" is INVALID.',
      'DROP INDEX CONCURRENTLY "items_id_idx"; then run apply again. Finished steps are not repeated.',
    ),
  });
  const error = await rejection(
    resumeCommittedStep(step, world.journal, world.engine, {
      retries: 0,
      wrap: (caught) =>
        new OkmError(
          "invalid",
          `Migration ${step.migrationId} failed at step 3: ${caught instanceof Error ? caught.message : "failed"}`,
        ),
    }),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.message).toContain('Index "items_id_idx" is INVALID.');
    expect(error.message).toContain("partial index will be dropped and rebuilt");
    expect(error.fix.summary).toContain("DROP INDEX CONCURRENTLY");
  }
});

const boundaries: readonly StepBoundary[] = ["before-started", "after-started", "after-ddl"];

for (const boundary of boundaries) {
  test(`crash ${boundary} then a second run finishes`, async () => {
    const world = harness({ probe: "absent", probed: true });
    const stopped = await rejection(
      resumeCommittedStep(step, world.journal, world.engine, {
        retries: 0,
        failAt: boundary,
        wrap: () => new OkmError("invalid", "failed"),
      }),
    );
    expect(stopped).toBeInstanceOf(Error);
    if (boundary === "before-started") expect(world.marker).toBeUndefined();
    if (boundary === "after-started") {
      expect(world.marker?.state).toBe("started");
      expect(world.calls).not.toContain("run");
    }
    if (boundary === "after-ddl") {
      expect(world.marker?.state).toBe("started");
      expect(world.calls).toContain("run");
      expect(world.history).toBe(false);
    }
    world.calls.length = 0;
    world.engine = engineFor(world, "applied", true);
    await resumeCommittedStep(step, world.journal, world.engine, {
      retries: 0,
      wrap: () => new OkmError("invalid", "failed"),
    });
    expect(world.history).toBe(true);
    expect(world.marker).toBeUndefined();
    if (boundary === "after-ddl") expect(world.calls).not.toContain("run");
  });
}

test("an index definition matches only when the parser can prove it", () => {
  expect(
    indexDefinitionVerdict(
      'create unique index concurrently "items_id_idx" on "public"."items" ("id")',
      "CREATE UNIQUE INDEX items_id_idx ON public.items USING btree (id)",
      "public",
    ),
  ).toBe("match");
  expect(
    indexDefinitionVerdict(
      "create index concurrently items_id_idx on items (note)",
      "CREATE INDEX items_id_idx ON public.items USING btree (id)",
      "public",
    ),
  ).toBe("differ");
  expect(
    indexDefinitionVerdict(
      "create index concurrently items_id_idx on items ((lower(name)))",
      "CREATE INDEX items_id_idx ON public.items USING btree (lower(name))",
      "public",
    ),
  ).toBe("unparsed");
});

test("a check definition matches the catalog spelling", () => {
  expect(
    constraintDefinitionVerdict(
      'alter table "public"."items" add constraint "items_id_check" check ("id" > 0) not valid',
      "CHECK ((id > 0)) NOT VALID",
    ),
  ).toBe("match");
  expect(
    constraintDefinitionVerdict(
      "alter table items add constraint items_id_check check (id > 1) not valid",
      "CHECK ((id > 0)) NOT VALID",
    ),
  ).toBe("differ");
});

type World = {
  marker: StepMarker | undefined;
  history: boolean;
  calls: string[];
  journal: StepJournal;
  engine: StepEngine;
};

function harness(input: {
  readonly state?: MarkerState;
  readonly probe: ProbeResult;
  readonly probed: boolean;
  readonly sqlHash?: string;
  readonly runError?: Error;
  readonly cleanupError?: Error;
}): World {
  const world: World = {
    marker:
      input.state === undefined
        ? undefined
        : {
            migrationId: step.migrationId,
            stepIndex: step.stepIndex,
            kind: step.kind,
            sqlHash: input.sqlHash ?? step.sqlHash,
            state: input.state,
            attempt: 1,
          },
    history: false,
    calls: [],
    journal: undefined as unknown as StepJournal,
    engine: undefined as unknown as StepEngine,
  };
  world.journal = journalFor(world);
  world.engine = engineFor(world, input.probe, input.probed, input.runError, input.cleanupError);
  return world;
}

function journalFor(world: World): StepJournal {
  return {
    async read() {
      return world.marker;
    },
    async start(committed, attempt) {
      world.calls.push("start");
      world.marker = {
        migrationId: committed.migrationId,
        stepIndex: committed.stepIndex,
        kind: committed.kind,
        sqlHash: committed.sqlHash,
        state: "started",
        attempt,
      };
    },
    async fail(_migrationId, _stepIndex, _code, _text) {
      if (world.marker !== undefined) world.marker = { ...world.marker, state: "failed" };
    },
    async complete() {
      world.calls.push("complete");
      world.marker = undefined;
      world.history = true;
    },
  };
}

function engineFor(
  world: World,
  probe: ProbeResult,
  probed: boolean,
  runError?: Error,
  cleanupError?: Error,
): StepEngine {
  return {
    probed,
    async probe() {
      world.calls.push("probe");
      return probe;
    },
    async cleanup() {
      world.calls.push("cleanup");
      if (cleanupError !== undefined) throw cleanupError;
    },
    async run() {
      world.calls.push("run");
      if (runError !== undefined) throw runError;
    },
  };
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return undefined;
}
