/**
 * Morph declarations: closed targets, column pairs, and a catalog that ignores the relation.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/index.js";
import {
  id,
  morph,
  morphMany,
  morphTo,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

const tasks = table(
  "tasks",
  { id: id({ default: "none" }), title: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);
const lists = table(
  "lists",
  { id: id({ default: "none" }), name: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);
const comments = table(
  "comments",
  {
    id: id({ default: "none" }),
    body: text(),
    commentableType: text(),
    commentableId: uuid(),
  },
  { relations: { commentable: morph("commentable", ["tasks", "lists"]) } },
);

test("morph resolves both directions and does not change the catalog hash", () => {
  const plain = table("comments", {
    id: id({ default: "none" }),
    body: text(),
    commentableType: text(),
    commentableId: uuid(),
  });
  const withMorph = schema({ casing: "snake", tables: [tasks, lists, comments] });
  const without = schema({
    casing: "snake",
    tables: [
      table("tasks", { id: id({ default: "none" }), title: text() }),
      table("lists", { id: id({ default: "none" }), name: text() }),
      plain,
    ],
  });
  expect(catalogHash(withMorph.catalog)).toBe(catalogHash(without.catalog));
  const relation = withMorph.model.comments?.relations[0];
  expect(relation?.morph?.direction).toBe("to");
  expect(relation?.morph?.targets.map((target) => target.type)).toEqual(["tasks", "lists"]);
  expect(relation?.local).toEqual(["commentable_id"]);
  const reverse = withMorph.model.tasks?.relations[0];
  expect(reverse?.kind).toBe("many");
  expect(reverse?.table).toBe("comments");
  expect(reverse?.morph?.typeValue).toBe("tasks");
  expect(reverse?.local).toEqual(["id"]);
  expect(morphTo("commentable", "tasks", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01")).toEqual({
    commentableType: "tasks",
    commentableId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01",
  });
});

test("an unknown target, a bad id type, and a missing column name the table and column", () => {
  const owner = (idType: "uuid" | "text", relation: ReturnType<typeof morph>) =>
    table(
      "comments",
      {
        id: id({ default: "none" }),
        commentableType: text(),
        commentableId: idType === "uuid" ? uuid() : text(),
      },
      { relations: { commentable: relation } },
    );
  const missing = capture(() =>
    schema({
      tables: [tasks, lists, owner("uuid", morph("commentable", ["tasks", "nope"]))],
    }),
  );
  expect(missing.code).toBe("OKM1020");
  expect(missing.message).toContain("nope");
  expect(missing.message).toContain("comments.commentable");

  const mismatch = capture(() =>
    schema({ tables: [tasks, lists, owner("text", morph("commentable", ["tasks", "lists"]))] }),
  );
  expect(mismatch.code).toBe("OKM1022");
  expect(mismatch.message).toContain("comments.commentableId");
  expect(mismatch.message).toContain("tasks.id");
  expect(mismatch.message).toContain("Accepted type: uuid");

  const absent = capture(() =>
    schema({
      tables: [
        tasks,
        lists,
        table(
          "comments",
          { id: id({ default: "none" }), body: text(), commentableId: uuid() },
          { relations: { commentable: morph("commentable", ["tasks", "lists"]) } },
        ),
      ],
    }),
  );
  expect(absent.code).toBe("OKM1021");
  expect(absent.message).toContain("commentableType");
  expect(absent.message).toContain("comments");
});

test("a composite key and a target left off the closed list fail at schema", () => {
  const wide = capture(() =>
    schema({
      tables: [
        table("pair", { left: text(), right: text() }, { primaryKey: ["left", "right"] }),
        table(
          "comments",
          {
            id: id({ default: "none" }),
            commentableType: text(),
            commentableId: text(),
          },
          { relations: { commentable: morph("commentable", ["pair"]) } },
        ),
      ],
    }),
  );
  expect(wide.code).toBe("OKM1021");
  expect(wide.message).toContain("pair");
  expect(wide.message).toContain("left");
  expect(wide.message).toContain("right");

  const leftOut = capture(() =>
    schema({
      tables: [
        tasks,
        table(
          "notes",
          { id: id({ default: "none" }) },
          { relations: { comments: morphMany("comments", "commentable") } },
        ),
        comments,
      ],
    }),
  );
  expect(leftOut.code).toBe("OKM1020");
  expect(leftOut.message).toContain("notes");
  expect(leftOut.message).toContain("Accepted tables: tasks, lists");
});
