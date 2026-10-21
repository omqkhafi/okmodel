/**
 * postgres.js and the built-in client describe the same statement the same way.
 */

import { expect } from "bun:test";

import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { connectDescribe } from "../src/tooling/describe/protocol.js";
import { describeSql, resultFromOutcome } from "../src/tooling/describe/provider.js";
import { PROOF_CASES } from "./describe-fixture.js";
import { applyFixture, expectProof, expectTypes } from "./describe-proof.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "postgres.js and the wire client return the same describe",
  async () => {
    const database = await createIsolatedDatabase();
    const pool = openPostgres({ url: database.url, max: 1 });
    const client = await connectDescribe(database.url);
    try {
      await applyFixture(pool);
      await expectProof(pool);
      await expectTypes(pool);
      const statements = [
        ...PROOF_CASES.map((item) => item.sql),
        "SELECT mood AS mood_col, pos AS pos_col, tags AS tags_col, $1::pos AS pos_param, $2::mood[] AS mood_array FROM item WHERE pos = $3",
        "SELECT stamp()",
      ];
      for (const sql of statements) {
        const fromPool = await pool.describe!(sql);
        const fromWire = resultFromOutcome(await client.describe(sql));
        expect(fromWire.parameters, sql).toEqual(fromPool.parameters);
        expect(fromWire.fields, sql).toEqual(fromPool.fields);
      }
      const viaPool = await describeSql({ text: "SELECT name FROM item", url: database.url, pool });
      const viaWire = await describeSql({ text: "SELECT name FROM item", url: database.url });
      expect(viaWire.fields).toEqual(viaPool.fields);
      expect(viaWire.parameters).toEqual(viaPool.parameters);
    } finally {
      client.close();
      await pool.close();
      await database.close();
    }
  },
  30_000,
);
