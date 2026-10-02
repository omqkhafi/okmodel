/**
 * Row types emitted from the schema.
 * Mode: emitted.
 */

export interface Users {
  readonly id: string;
  readonly email: string;
  readonly nickname: string | null;
}

export interface UsersInsert {
  readonly email: string;
  readonly nickname: string | null | undefined;
}

export interface UsersUpdate {
  readonly email: string | undefined;
  readonly nickname: string | null | undefined;
}

export interface Tasks {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done";
  readonly notes: string | null;
  readonly position: number;
  readonly locked: string;
}

export interface TasksInsert {
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done" | undefined;
  readonly notes: string | null | undefined;
  readonly secret: string;
  readonly position: number | undefined;
}

export interface TasksUpdate {
  readonly ownerId: string | undefined;
  readonly title: string | undefined;
  readonly status: "draft" | "active" | "done" | undefined;
  readonly notes: string | null | undefined;
  readonly secret: string | undefined;
  readonly position: number | undefined;
}

export interface Rows {
  readonly users: Users;
  readonly tasks: Tasks;
}

export interface Inserts {
  readonly users: UsersInsert;
  readonly tasks: TasksInsert;
}

export interface Updates {
  readonly users: UsersUpdate;
  readonly tasks: TasksUpdate;
}
