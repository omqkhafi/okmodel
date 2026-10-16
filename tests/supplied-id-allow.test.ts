/**
 * A client-generator id can be supplied with `{ allow: ["id"] }`.
 */

import { expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { uuidv4 } from "../src/runtime/ids/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import type { Connected } from "../src/runtime/types.js";

const KEPT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FILLED = "33333333-3333-4333-8333-333333333333";

const users = table("users", { id: t.id({ default: uuidv4 }), name: t.text() });
const posts = table("posts", { id: t.id(), title: t.text() });
const secrets = table("secrets", { id: t.text().primaryKey(), token: t.text().guarded() });
const codes = table("codes", { id: t.text().primaryKey().guarded(), label: t.text() });
const app = schema({ tables: [users, posts, secrets, codes] });

test("allow writes a client id and refuses a database default", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) {
      await pool.execute(statement);
    }
    const db = await connect(pool, {
      schema: app,
      generators: { uuidv4: () => FILLED },
    });

    const kept = await db.users.insert({ id: KEPT, name: "Ada" }, { allow: ["id"] });
    expect(kept.id).toBe(KEPT);

    const mixed = await db.users.insert([{ id: OTHER, name: "Grace" }, { name: "Lin" }], {
      allow: ["id"],
    });
    expect(mixed.map((row) => row.id)).toEqual([OTHER, FILLED]);

    let bare: unknown;
    try {
      await db.users.insert({ id: KEPT, name: "no" } as never);
    } catch (error) {
      bare = error;
    }
    expect(bare).toBeInstanceOf(OkmError);
    if (bare instanceof OkmError) expect(bare.code).toBe("OKM1190");

    let server: unknown;
    try {
      await db.posts.insert({ id: KEPT, title: "t" }, { allow: ["id"] });
    } catch (error) {
      server = error;
    }
    expect(server).toBeInstanceOf(OkmError);
    if (server instanceof OkmError) expect(server.code).toBe("OKM1190");

    const generated = await db.posts.insert({ title: "ok" });
    expect(generated.id).not.toBe(KEPT);

    let changed: unknown;
    try {
      await db.users.update({ where: { id: KEPT }, set: { id: OTHER } }, { allow: ["id"] });
    } catch (error) {
      changed = error;
    }
    expect(changed).toBeInstanceOf(OkmError);
    if (changed instanceof OkmError) expect(changed.code).toBe("OKM1190");

    const secret = await db.secrets.insert({ id: "s", token: "hidden" }, { allow: ["token"] });
    expect(secret.token).toBe("hidden");

    let guardedKey: unknown;
    try {
      await db.codes.insert({ id: "c", label: "kept" }, { allow: ["id"] });
    } catch (error) {
      guardedKey = error;
    }
    expect(guardedKey).toBeInstanceOf(OkmError);
    if (guardedKey instanceof OkmError) expect(guardedKey.code).toBe("OKM1190");

    let again: unknown;
    try {
      await db.users.insert({ id: KEPT, name: "again" }, { allow: ["id"] });
    } catch (error) {
      again = error;
    }
    expect(again).toBeInstanceOf(OkmError);
    if (again instanceof OkmError) expect(again.kind).toBe("unique");

    await db.close();
  } finally {
    await pool.close();
  }
});

async function listShape(db: Connected<typeof app>): Promise<void> {
  const rows = await db.users.insert([{ id: KEPT, name: "Ada" }, { name: "Lin" }], {
    allow: ["id"],
  });
  expectTypeOf(rows).toEqualTypeOf<readonly { readonly id: string; readonly name: string }[]>();

  // @ts-expect-error a longer allow list does not open id
  await db.users.insert([{ id: KEPT, name: "Ada" }], { allow: ["id", "name"] });

  // A database-default id still typechecks. The runtime throws OKM1190.
  await db.posts.insert({ id: KEPT, title: "t" }, { allow: ["id"] });
}

void listShape;
