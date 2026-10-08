/**
 * Two hundred calls on one caller signal add no listener warning (QA-L8).
 *
 * Each call used to add its own abort listener to the signal. Node warns past
 * ten listeners on one signal. The calls now share one listener per signal.
 * Runs under `bun run db:up`.
 */

import { expect } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { createIsolatedDatabase, withPostgres } from "../packages/harness/src/postgres.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const gate = await loadPostgresGate();
requirePostgresWhenAsked(gate);

postgresTest(
  gate,
  "two hundred inserts and reads on one signal raise no listener warning (QA-L8)",
  async () => {
    const database = await createIsolatedDatabase();
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(`${warning.name}: ${warning.message}`);
    };
    process.on("warning", onWarning);
    try {
      await withPostgres(
        (sql) => sql.unsafe("create table notes (id text primary key, title text)"),
        database.url,
      );
      const db = connect(database.url, { schema: app });
      try {
        await db.connected;
        const controller = new AbortController();
        const { signal } = controller;
        await Promise.all(
          Array.from({ length: 200 }, (_, index) =>
            db.notes.insert({ id: `n${String(index)}`, title: `t${String(index)}` }, { signal }),
          ),
        );
        const rows = await Promise.all(
          Array.from({ length: 200 }, () => db.notes.find({ limit: 1, signal })),
        );
        expect(rows.every((found) => found.length === 1)).toBe(true);
        controller.abort();
        expect(warnings).toEqual([]);
      } finally {
        await db.close();
      }
    } finally {
      process.off("warning", onWarning);
      await database.close();
    }
  },
  60_000,
);
