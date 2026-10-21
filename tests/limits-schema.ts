/**
 * Schema and seed shared by the `connect({ limits })` tests (M-7).
 *
 * Five notes, three comments and three tags on the first note, so a default of
 * 3 stops short on notes and stops exactly on the first note's relations.
 */

import {
  id,
  integer,
  many,
  manyThrough,
  one,
  schema,
  table,
  text,
  tsvector,
  uuid,
} from "../src/dialects/pg/index.js";
import type { Bounded, Connected } from "../src/runtime/types.js";

const comments = table(
  "comments",
  { id: id({ default: "none" }), noteId: uuid().references("notes"), body: text() },
  { relations: { note: one("notes", "noteId") } },
);

const tags = table(
  "tags",
  { id: id({ default: "none" }), name: text() },
  { relations: { notes: manyThrough("notes", { through: "noteTags" }) } },
);

const noteTags = table("noteTags", {
  id: id({ default: "none" }),
  noteId: uuid().references("notes"),
  tagId: uuid().references("tags"),
});

const notes = table(
  "notes",
  { id: id({ default: "none" }), title: text(), doc: tsvector(), rank: integer() },
  {
    presets: { top: (q) => q.where({ rank: 0 }) },
    relations: {
      comments: many("comments", "noteId"),
      tags: manyThrough("tags", { through: "noteTags" }),
    },
  },
);

/** The schema the limits tests read. */
export const limitsApp = schema({ casing: "snake", tables: [notes, comments, tags, noteTags] });

/** The limits every key of which is set, so a read may state no limit. */
export type AllLimits = {
  readonly find: number;
  readonly include: number;
  readonly page: number;
  readonly groupBy: number;
  readonly max: number;
};

/** A client on {@link limitsApp} typed as if every default were set. */
export type LimitsDb = Connected<Bounded<typeof limitsApp, AllLimits>>;

/**
 * A uuid for a seed row.
 *
 * @param kind - `n` note, `c` comment, `t` tag, `j` join row
 * @param n - Index
 * @returns A uuid
 */
export function limitsKey(kind: "n" | "c" | "t" | "j", n: number): string {
  const code = { n: 1, c: 2, t: 3, j: 4 }[kind];
  return `01890c5a-8f0e-7c3a-9b2d-${code.toString(16).padStart(4, "0")}00${n
    .toString(16)
    .padStart(6, "0")}`;
}

/**
 * Seeds five notes, three comments and three tags on note 0.
 *
 * @param db - Client with no limits, or with limits that fit the seed
 */
export async function seedLimits(db: LimitsDb): Promise<void> {
  for (let n = 0; n < 5; n++) {
    await db.notes.insert({ id: limitsKey("n", n), title: `note ${n}`, doc: `'note':1`, rank: n });
  }
  for (let n = 0; n < 3; n++) {
    await db.comments.insert({ id: limitsKey("c", n), noteId: limitsKey("n", 0), body: `c${n}` });
    await db.tags.insert({ id: limitsKey("t", n), name: `tag ${n}` });
    await db.noteTags.insert({
      id: limitsKey("j", n),
      noteId: limitsKey("n", 0),
      tagId: limitsKey("t", n),
    });
  }
}
