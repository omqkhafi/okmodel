/**
 * Row, insert, and update shapes for the sample tables.
 */

import { expectTypeOf } from "expect-type";

import { type Citext, citext } from "./extensions/citext.js";
import {
  ArchiveCrud,
  Crud,
  type TablesWith,
  type TablesWithColumn,
  tableShapes,
} from "./generics.js";
import {
  type RegisteredRow,
  type Insert,
  type Row,
  type TableName,
  type Update,
  appSchema,
  tasks,
} from "./index.js";
import { type DuplicateNames } from "./schema.js";
import { type TableId, table } from "./table.js";
import { t } from "./column.js";

type TaskRow = {
  readonly id: TableId<"tasks">;
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done";
  readonly notes: string | null;
  readonly meta: { readonly ok: boolean };
  readonly tags: readonly string[];
  readonly rank: number;
  readonly role: string;
  readonly kind: "bug" | "feature";
};

type TaskInsert = {
  readonly ownerId: string;
  readonly title: string;
  readonly kind: "bug" | "feature";
  readonly meta: { readonly ok: boolean };
  readonly tags: readonly string[];
  readonly secret: string;
} & {
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
};

type TaskUpdate = {
  readonly ownerId?: string;
  readonly title?: string;
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
  readonly meta?: { readonly ok: boolean };
  readonly tags?: readonly string[];
  readonly kind?: "bug" | "feature";
  readonly secret?: string;
};

expectTypeOf<Row<"tasks">>().toEqualTypeOf<TaskRow>();
expectTypeOf<Insert<"tasks">>().toEqualTypeOf<TaskInsert>();
expectTypeOf<Update<"tasks">>().toEqualTypeOf<TaskUpdate>();

expectTypeOf<Row<"users">>().toEqualTypeOf<{
  readonly id: TableId<"users">;
  readonly email: string;
  readonly nickname: string | null;
}>();
expectTypeOf<RegisteredRow<"users">>().toEqualTypeOf<Row<"users">>();
expectTypeOf<RegisteredRow<"tasks">>().toEqualTypeOf<Row<"tasks">>();

expectTypeOf<Insert<"users">>().toEqualTypeOf<
  { readonly email: string } & { readonly nickname?: string | null }
>();

const shapes = tableShapes(tasks);
expectTypeOf<typeof shapes.row>().toEqualTypeOf<TaskRow>();
expectTypeOf<typeof shapes.insert>().toEqualTypeOf<TaskInsert>();
expectTypeOf<typeof shapes.update>().toEqualTypeOf<TaskUpdate>();

expectTypeOf<Row<"tasks", typeof appSchema>>().toEqualTypeOf<Row<"tasks">>();
expectTypeOf<TableName>().toEqualTypeOf<"users" | "tasks">();
expectTypeOf<TableName<typeof appSchema>>().toEqualTypeOf<"users" | "tasks">();

expectTypeOf<TablesWith<typeof appSchema, "archivable">>().toEqualTypeOf<"tasks">();
expectTypeOf<TablesWithColumn<typeof appSchema, "ownerId">>().toEqualTypeOf<"tasks">();
expectTypeOf<TablesWithColumn<typeof appSchema, "email">>().toEqualTypeOf<"users">();

const crud = new Crud(appSchema, "tasks");
expectTypeOf<Parameters<typeof crud.create>[0]>().toEqualTypeOf<Insert<"tasks">>();
expectTypeOf<ReturnType<typeof crud.get>>().toEqualTypeOf<Row<"tasks">>();

const archive = new ArchiveCrud(appSchema, "tasks");
expectTypeOf<ReturnType<typeof archive.archive>>().toEqualTypeOf<{
  readonly count: number;
  readonly archiveId: string;
}>();

const people = table("people", {
  id: t.id(),
  email: citext(),
});
expectTypeOf<(typeof people)["~row"]>().toEqualTypeOf<{
  readonly id: TableId<"people">;
  readonly email: Citext;
}>();

expectTypeOf<(typeof appSchema)["~extensions"]>().toEqualTypeOf<{ readonly citext: Citext }>();
expectTypeOf<(typeof appSchema)["~missingRefs"]>().toEqualTypeOf<never>();
expectTypeOf<DuplicateNames<["a", "b", "a"]>>().toEqualTypeOf<"a">();
expectTypeOf<DuplicateNames<["a", "b"]>>().toEqualTypeOf<never>();
