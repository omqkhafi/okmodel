/**
 * `db.batch` and `tx.batch` keep `.sensitive()` values out of every observer
 * event and every error, as the single-write paths do (QA N-130).
 *
 * Runs on the Docker Postgres topology. A batch passes through the same
 * redaction as one write: the bound values of a sensitive column are shown as
 * `[redacted]` in `onQuery` parameters, on success and on failure.
 */

import { expect } from "bun:test";
import { inspect } from "node:util";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";
import { watch, type Watch } from "./observe-conformance-watch.js";

const vault = table("vault", {
  id: t.text().primaryKey(),
  label: t.text(),
  secret: t.text().sensitive().unique(),
  code: t.text().hidden().nullable(),
});

const app = schema({ casing: "snake", tables: [vault] });
const gate = await loadPostgresGate();

type Db = Connected<typeof app>;

const SECRETS = ["secret-first-7a1c", "secret-second-3e9d", "secret-changed-5b2f"] as const;

/** Everything an observer or a caller can read about a run, as one string. */
function everything(seen: Watch, extra: readonly unknown[] = []): string {
  return JSON.stringify([
    seen.events,
    seen.queries,
    extra.map((item) => inspect(item, { depth: 12 })),
  ]);
}

function expectQuiet(text: string): void {
  for (const value of SECRETS) expect(text).not.toContain(value);
}

async function failure(run: () => PromiseLike<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function withDb(body: (db: Db, seen: Watch) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const seen = watch({ params: true });
    const db = connect(primaryUrl(), {
      schema: app,
      searchPath: schemaName,
      max: 1,
      onWrite: seen.onWrite,
      onQuery: seen.onQuery,
    });
    try {
      await db.connected;
      await body(db, seen);
    } finally {
      await db.close();
    }
  });
}

function shown(seen: Watch): readonly unknown[] {
  return seen.queries.flatMap((event) => event.params ?? []);
}

postgresTest(
  gate,
  "db.batch redacts a sensitive value in an insert and an update, as one write does",
  async () => {
    await withDb(async (db, seen) => {
      await db.vault.insert({ id: "one", label: "single-label", secret: SECRETS[0] });
      await seen.flush();
      const single = shown(seen);
      expect(single).toContain("[redacted]");
      expect(single).toContain("single-label");
      seen.queries.length = 0;
      seen.events.length = 0;

      await db.batch([
        db.vault.insert({ id: "two", label: "batch-label", secret: SECRETS[1] }),
        db.vault.update({ where: { id: "one" }, set: { secret: SECRETS[2] } }),
      ]);
      await seen.flush();
      expect(seen.queries.length).toBeGreaterThan(0);
      expectQuiet(everything(seen));
      const params = shown(seen);
      expect(params.filter((value) => value === "[redacted]")).toHaveLength(2);
      expect(params).toContain("batch-label");
      expect(seen.errors).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "tx.batch redacts a sensitive value in an insert and an update",
  async () => {
    await withDb(async (db, seen) => {
      await db.vault.insert({ id: "one", label: "l", secret: SECRETS[0] });
      await seen.flush();
      seen.queries.length = 0;
      seen.events.length = 0;

      await db.tx(async (tx) => {
        await tx.batch([
          tx.vault.insert({ id: "two", label: "batch-label", secret: SECRETS[1] }),
          tx.vault.update({ where: { id: "one" }, set: { secret: SECRETS[2] } }),
        ]);
      });
      await seen.flush();
      expect(seen.queries.length).toBeGreaterThan(0);
      expectQuiet(everything(seen));
      expect(shown(seen).filter((value) => value === "[redacted]")).toHaveLength(2);
      expect(seen.errors).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a failing batch keeps a sensitive value out of the error, its cause, and the events",
  async () => {
    await withDb(async (db, seen) => {
      await db.vault.insert({ id: "one", label: "l", secret: SECRETS[0] });
      await seen.flush();
      seen.queries.length = 0;
      seen.events.length = 0;

      const viaDb = await failure(() =>
        db.batch([
          db.vault.insert({ id: "two", label: "l", secret: SECRETS[1] }),
          db.vault.insert({ id: "three", label: "l", secret: SECRETS[0] }),
        ]),
      );
      expect(viaDb.kind).toBe("unique");
      expect(viaDb.batchIndex).toBe(1);

      const viaTx = await failure(() =>
        db.tx(async (tx) => {
          await tx.batch([
            tx.vault.insert({ id: "four", label: "l", secret: SECRETS[1] }),
            tx.vault.insert({ id: "five", label: "l", secret: SECRETS[0] }),
          ]);
        }),
      );
      expect(viaTx.kind).toBe("unique");
      await seen.flush();

      expect(seen.queries.some((event) => event.error !== undefined)).toBe(true);
      expect(shown(seen)).toContain("[redacted]");
      expectQuiet(everything(seen, [viaDb, viaDb.cause, viaTx, viaTx.cause]));
      for (const error of [viaDb, viaTx]) {
        expect(error.message).not.toContain(SECRETS[0]);
        expect(JSON.stringify(error)).not.toContain(SECRETS[0]);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a first-or-create lookup inside a batch redacts the sensitive value it searches for",
  async () => {
    await withDb(async (db, seen) => {
      await db.vault.insert({ id: "one", label: "l", secret: SECRETS[0] });
      await seen.flush();
      seen.queries.length = 0;
      seen.events.length = 0;

      const [found] = await db.batch([
        db.vault.insert(
          { id: "two", label: "l", secret: SECRETS[0] },
          { onConflict: { on: "secret", return: true } },
        ),
      ]);
      expect((found as { id: string }).id).toBe("one");
      await seen.flush();
      expect(seen.queries.length).toBeGreaterThan(1);
      expectQuiet(everything(seen));
      expect(seen.errors).toEqual([]);
    });
  },
  60_000,
);

const HIDDEN = "hidden-batch-value-4c8e";

postgresTest(
  gate,
  "db.batch and tx.batch redact a hidden value",
  async () => {
    await withDb(async (db, seen) => {
      await db.batch([
        db.vault.insert({ id: "h1", label: "shown-label", secret: SECRETS[0], code: HIDDEN }),
      ]);
      await seen.flush();
      expect(shown(seen)).toContain("[redacted]");
      expect(shown(seen)).toContain("shown-label");
      expect(everything(seen)).not.toContain(HIDDEN);
      seen.queries.length = 0;
      seen.events.length = 0;
      await db.tx(async (tx) => {
        await tx.batch([tx.vault.update({ where: { id: "h1" }, set: { code: HIDDEN } })]);
      });
      await seen.flush();
      expect(shown(seen)).toContain("[redacted]");
      expect(everything(seen)).not.toContain(HIDDEN);
    });
  },
  60_000,
);
