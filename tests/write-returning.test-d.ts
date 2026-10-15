/**
 * `returning: true` matches what update and delete actually return.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", {
  id: text().primaryKey(),
  title: text(),
  rank: text().guarded(),
});

const app = schema({ tables: [notes] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const rows = db.notes.update(
    { where: { id: "a" }, set: { rank: "1" } },
    { allow: ["rank"], returning: true },
  );
  expectTypeOf(rows).resolves.toEqualTypeOf<
    readonly {
      readonly id: string;
      readonly title: string;
      readonly rank: string;
    }[]
  >();
  const counted = db.notes.update({ where: { id: "a" }, set: { rank: "1" } }, { allow: ["rank"] });
  expectTypeOf(counted).resolves.toEqualTypeOf<{ readonly count: number }>();

  // @ts-expect-error delete does not accept returning: true
  void db.notes.delete({ where: { id: "a" } }, { returning: true });
}

void shapes;
