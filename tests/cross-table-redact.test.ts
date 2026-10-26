/**
 * A shared field name is redacted with the table the statement targets.
 *
 * `a_items.pin` is jsonb and `b_items.pin` is text. The first table's codec
 * must not decide the parameter for the other table.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { many, schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";

const A_PIN = "pin-a-secret-7f3a9c";
const B_PIN = "pin-b-secret-7f3a9c";

function items(order: "ab" | "ba") {
  const aItems = table("a_items", {
    id: t.text().primaryKey(),
    pin: t.jsonb().sensitive(),
  });
  const bItems = table("b_items", {
    id: t.text().primaryKey(),
    pin: t.text().sensitive(),
  });
  return schema({
    casing: "snake",
    tables: order === "ab" ? [aItems, bItems] : [bItems, aItems],
  });
}

function client(order: "ab" | "ba") {
  const db = createClient(items(order), {} as DriverPool, { ownsPool: false });
  void db.connected.catch(() => undefined);
  return db;
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

test("insert, update, and find redact the targeted table in both schema orders", async () => {
  for (const order of ["ab", "ba"] as const) {
    const db = client(order);
    const inserted = textOf(await db.b_items.insert({ id: "1", pin: B_PIN }).inspect());
    const updated = textOf(
      await db.b_items.update({ where: { id: "1" }, set: { pin: B_PIN } }).inspect(),
    );
    const found = textOf(await db.b_items.find({ where: { pin: B_PIN }, limit: 1 }).inspect());
    const own = textOf(await db.a_items.insert({ id: "1", pin: A_PIN }).inspect());
    for (const view of [inserted, updated, found]) {
      expect(view).toContain("[redacted]");
      expect(view).not.toContain(B_PIN);
    }
    expect(own).toContain("[redacted]");
    expect(own).not.toContain(A_PIN);
  }
});

test("an include redacts the related table's codec, not the root codec", async () => {
  const comments = table("comments", {
    id: t.text().primaryKey(),
    postId: t.text().references("posts"),
    pin: t.text().sensitive(),
  });
  const posts = table(
    "posts",
    {
      id: t.text().primaryKey(),
      pin: t.jsonb().sensitive(),
    },
    { relations: { comments: many("comments", "postId") } },
  );
  const app = schema({ casing: "snake", tables: [posts, comments] });
  const db = createClient(app, {} as DriverPool, { ownsPool: false });
  void db.connected.catch(() => undefined);
  const view = textOf(
    await db.posts
      .find({
        where: { pin: A_PIN },
        include: { comments: { where: { pin: B_PIN }, limit: 1 } },
        limit: 1,
      })
      .inspect(),
  );
  expect(view).toContain("[redacted]");
  expect(view).not.toContain(A_PIN);
  expect(view).not.toContain(B_PIN);
});
