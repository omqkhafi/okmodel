export type jsonb<T> = T;

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
  readonly nickname?: string | null;
}

export interface UsersUpdate {
  readonly email?: string;
  readonly nickname?: string | null;
}

export interface Tasks {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "done";
  readonly notes: string | null;
  readonly payload: jsonb<unknown>;
  readonly position: number;
  readonly locked: string;
}

export interface TasksInsert {
  readonly ownerId: string;
  readonly title: string;
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
  readonly payload: jsonb<unknown>;
  readonly secret: string;
  readonly position?: number;
}

export interface TasksUpdate {
  readonly ownerId?: string;
  readonly title?: string;
  readonly status?: "draft" | "active" | "done";
  readonly notes?: string | null;
  readonly payload?: jsonb<unknown>;
  readonly secret?: string;
  readonly position?: number;
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
