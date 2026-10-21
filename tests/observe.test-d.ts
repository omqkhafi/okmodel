/**
 * Type snapshot for `okm.observe/1` event shapes (G-4).
 *
 * Extra fields are allowed. Removed or retyped required fields fail.
 */

import { expectTypeOf } from "expect-type";

import type {
  ObserveEvent,
  OutcomeEvent,
  SavepointEvent,
  WriteEvent,
} from "../src/runtime/observe-types.js";

const write = {
  type: "write" as const,
  unit: "u1",
  seq: 0,
  dialect: "postgres" as const,
  table: "notes",
  op: "insert" as const,
  rowCount: null,
  rowCountMode: "unknown" as const,
  tenant: null,
  settings: [] as const,
  durationMs: 1,
  source: "client" as const,
};

const savepoint = {
  type: "savepoint" as const,
  unit: "u1",
  name: "okm_t1",
  state: "released" as const,
  depth: 1,
};

const outcome = {
  type: "outcome" as const,
  unit: "u1",
  outcome: "committed" as const,
  writes: 1,
};

expectTypeOf(write).toExtend<WriteEvent>();
expectTypeOf(savepoint).toExtend<SavepointEvent>();
expectTypeOf(outcome).toExtend<OutcomeEvent>();
expectTypeOf(write).toExtend<ObserveEvent>();
expectTypeOf(savepoint).toExtend<ObserveEvent>();
expectTypeOf(outcome).toExtend<ObserveEvent>();

// Extra fields are allowed on a value that already satisfies the event.
expectTypeOf({ ...write, extra: true }).toExtend<WriteEvent>();
expectTypeOf({ ...savepoint, tool: "x" }).toExtend<SavepointEvent>();
expectTypeOf({ ...outcome, note: 1 }).toExtend<OutcomeEvent>();

// Removed required fields fail.
expectTypeOf(write).not.toEqualTypeOf<Omit<WriteEvent, "unit">>();
expectTypeOf({ type: "write" as const, unit: "u1" }).not.toExtend<WriteEvent>();

// Retyped fields fail.
expectTypeOf({ ...write, seq: "0" }).not.toExtend<WriteEvent>();
expectTypeOf({ ...write, rowCountMode: "changed" as const, rowCount: null }).toExtend<WriteEvent>();
expectTypeOf({ ...outcome, outcome: "maybe" as const }).not.toExtend<OutcomeEvent>();
