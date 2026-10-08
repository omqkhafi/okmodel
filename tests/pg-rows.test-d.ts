/**
 * Inferred row, insert, and update shapes.
 */

import { expectTypeOf } from "expect-type";

import { type Insert, type Row, type Update } from "../src/contracts/index.js";
import { appSchema, tasks } from "./row-types-schema.js";
import { type Tasks, type TasksInsert, type TasksUpdate } from "./row-types-emitted.js";

type TaskRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done";
  readonly notes: string | null;
  readonly payload: unknown;
  readonly position: number;
  readonly locked: string;
};

expectTypeOf<Row<"tasks", typeof appSchema>>().toEqualTypeOf<TaskRow>();

expectTypeOf<Insert<"tasks", typeof appSchema>>().toEqualTypeOf<{
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done" | undefined;
  readonly notes: string | null | undefined;
  readonly payload: unknown;
  readonly secret: string;
  readonly position: number | undefined;
}>();

expectTypeOf<Update<"tasks", typeof appSchema>>().toEqualTypeOf<{
  readonly ownerId: string | undefined;
  readonly title: string | undefined;
  readonly status: "draft" | "active" | "done" | undefined;
  readonly notes: string | null | undefined;
  readonly payload: unknown;
  readonly secret: string | undefined;
  readonly position: number | undefined;
}>();

expectTypeOf<Row<"users", typeof appSchema>>().toEqualTypeOf<{
  readonly id: string;
  readonly email: string;
  readonly nickname: string | null;
}>();

expectTypeOf<Insert<"users", typeof appSchema>>().toEqualTypeOf<{
  readonly email: string;
  readonly nickname: string | null | undefined;
}>();

expectTypeOf<Tasks>().toEqualTypeOf<Row<"tasks", typeof appSchema>>();
expectTypeOf<TasksInsert>().toEqualTypeOf<{
  readonly ownerId: string;
  readonly title: string;
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
  readonly payload: unknown;
  readonly secret: string;
  readonly position?: number;
}>();
expectTypeOf<TasksUpdate>().toEqualTypeOf<{
  readonly ownerId?: string;
  readonly title?: string;
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
  readonly payload?: unknown;
  readonly secret?: string;
  readonly position?: number;
}>();

type ReferenceArgument = Parameters<(typeof tasks)["columns"]["ownerId"]["references"]>[0];
expectTypeOf<ReferenceArgument>().toEqualTypeOf<string>();
