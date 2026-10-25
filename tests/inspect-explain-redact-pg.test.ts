/**
 * Write `inspect()` and `explain()` redact hidden and sensitive parameters.
 *
 * A read `inspect()` already does. These tests lock the write plans and the
 * `explain()` result. Ordinary columns stay visible. `EXPLAIN` still runs with
 * the real parameters; the returned plan text is what this file checks.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  arr,
  eq,
  explain,
  fragment,
  ident,
  inc,
  json,
  raw,
  schema,
  t,
  table,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";

const TOKEN = "okmcanary-token-7f3a9c2e";
const CODE = "okmcanary-code-b41e2d18";
const SEAL = "okmcanary-seal-91c0e84a";
const LABEL = "alpha-label-55aa0193";
const NOTE = "it's a quote";

const notes = table("notes", {
  id: t.text().primaryKey(),
  label: t.text().unique(),
  token: t.text().sensitive().unique(),
  code: t.text().hidden({ filterable: true }).unique(),
  seal: t.text().hidden({ filterable: true }).sensitive().unique(),
  n: t.integer(),
  pin: t.integer().sensitive(),
  flag: t.boolean().sensitive(),
  note: t.text().sensitive(),
  flags: t.text().array().hidden({ filterable: true }),
  blob: t.jsonb().nullable().hidden().sensitive(),
  doc: t.jsonb().sensitive(),
  body: t.tsvector().hidden({ filterable: true }),
});

const app = schema({ casing: "snake", tables: [notes] });
const gate = await loadPostgresGate();

type Db = Connected<typeof app>;

class Peek {
  id = "";
  label = "";
}

function row(
  id: string,
  label: string,
  token = TOKEN,
  code = CODE,
  seal = SEAL,
): {
  id: string;
  label: string;
  token: string;
  code: string;
  seal: string;
  n: number;
  pin: number;
  flag: boolean;
  note: string;
  flags: string[];
  blob: { k: string };
  doc: { k: string };
  body: string;
} {
  return {
    id,
    label,
    token,
    code,
    seal,
    n: 2,
    pin: 1,
    flag: false,
    note: NOTE,
    flags: [code],
    blob: { k: seal },
    doc: { k: seal },
    body: "'alpha':1",
  };
}

function bound(value: unknown): string {
  return JSON.stringify(value);
}

function expectConcealed(
  value: unknown,
  secrets: readonly string[],
  kept: readonly string[] = [],
): void {
  const text = bound(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).toContain("[redacted]");
  for (const item of kept) expect(text).toContain(item);
}

async function withDb(body: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), {
      schema: app,
      searchPath: schemaName,
      max: 1,
    });
    try {
      await db.connected;
      await body(db);
    } finally {
      await db.close();
    }
  });
}

postgresTest(
  gate,
  "update inspect redacts concealed parameters and keeps an ordinary column",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const byId = db.notes.update({
        where: { id: "n1" },
        set: { token: TOKEN, code: CODE, seal: SEAL, label: "alpha-2" },
      });
      expect(bound(await byId.sql())).toContain(TOKEN);
      expectConcealed(await byId.inspect(), [TOKEN, CODE, SEAL], ["alpha-2"]);

      const byCode = db.notes.update({
        where: { code: CODE },
        set: { label: "alpha-3" },
      });
      expectConcealed(await byCode.inspect(), [CODE], ["alpha-3"]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "atomic update inspect redacts array and json operands",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const write = db.notes.update({
        where: { id: "n1" },
        set: {
          n: inc(2),
          flags: arr.append(CODE),
          blob: json.set(["k"], SEAL),
        },
      });
      const seen = bound(await write.inspect());
      expect(seen).not.toContain(CODE);
      expect(seen).not.toContain(SEAL);
      expect(seen).toContain("[redacted]");
      expect(seen).toContain("2");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "delete inspect redacts a hidden sensitive filter",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const write = db.notes.delete({ where: { seal: SEAL } });
      expectConcealed(await write.inspect(), [SEAL]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "db.batch inspect redacts concealed insert parameters",
  async () => {
    await withDb(async (db) => {
      const first = db.notes.insert(row("n1", LABEL));
      const second = db.notes.insert(row("n2", "bravo", `${TOKEN}-b`, `${CODE}-b`, `${SEAL}-b`));
      expectConcealed(await first.inspect(), [TOKEN, CODE, SEAL], [LABEL]);
      expectConcealed(await second.inspect(), [`${TOKEN}-b`, `${CODE}-b`, `${SEAL}-b`], ["bravo"]);
      await db.batch([first, second]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "tx inspect redacts a concealed update parameter",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      await db.tx(async (tx) => {
        const write = tx.notes.update({
          where: { id: "n1" },
          set: { token: TOKEN, label: "in-tx" },
        });
        expectConcealed(await write.inspect(), [TOKEN], ["in-tx"]);
        await write;
      });
    });
  },
  30_000,
);

postgresTest(
  gate,
  "tx.batch inspect redacts concealed parameters",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      await db.tx(async (tx) => {
        const inserted = tx.notes.insert(row("n2", "golf", `${TOKEN}-g`, `${CODE}-g`, `${SEAL}-g`));
        const updated = tx.notes.update({ where: { id: "n1" }, set: { label: "tx-batch" } });
        expectConcealed(
          await inserted.inspect(),
          [`${TOKEN}-g`, `${CODE}-g`, `${SEAL}-g`],
          ["golf"],
        );
        const updateText = bound(await updated.inspect());
        expect(updateText).toContain("tx-batch");
        expect(updateText).not.toContain(TOKEN);
        await tx.batch([inserted, updated]);
      });
    });
  },
  30_000,
);

postgresTest(
  gate,
  "first-or-create inspect redacts concealed parameters on insert and conflict",
  async () => {
    await withDb(async (db) => {
      const created = db.notes.insert(row("fc", "once"), {
        onConflict: { on: "label", return: true },
      });
      expectConcealed(await created.inspect(), [TOKEN, CODE, SEAL], ["once"]);
      await created;
      const again = db.notes.insert(row("fc2", "once", `${TOKEN}-2`, `${CODE}-2`, `${SEAL}-2`), {
        onConflict: { on: "label", return: true },
      });
      expectConcealed(await again.inspect(), [`${TOKEN}-2`, `${CODE}-2`, `${SEAL}-2`], ["once"]);
      await again;
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain find redacts concealed params and plan text and keeps the plan costs",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const found = await explain(
        db.notes,
        db.notes.find({
          where: { token: TOKEN, code: CODE, seal: SEAL },
          limit: 5,
        }),
      );
      expect(found.plan).not.toBeNull();
      const lines = found.plan ?? [];
      const text = lines.join("\n");
      expect(found.params.filter((item) => item === "[redacted]")).toHaveLength(3);
      expect(found.params).toContain("5");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(SEAL);
      expect(text).toContain("'[redacted]'");
      expect(text).not.toMatch(/\$\d/);
      const costs = lines.filter((line) => line.includes("cost=")).join("\n");
      expect(costs).not.toContain("[redacted]");
      expect(costs).toMatch(/cost=\d+\.\d+\.\.\d+\.\d+/);

      const plain = await explain(db.notes, db.notes.find({ where: { label: LABEL }, limit: 1 }));
      expect(plain.params).toContain(LABEL);
      expect(plain.plan?.join("\n")).toContain(LABEL);
      expect(plain.plan?.join("\n")).not.toContain("[redacted]");

      const pin = await explain(db.notes, db.notes.find({ where: { pin: 1 }, limit: 5 }));
      const pinLines = pin.plan ?? [];
      const pinCost = pinLines.filter((line) => line.includes("cost=")).join("\n");
      const pinFilter = pinLines.filter((line) => !line.includes("cost=")).join("\n");
      expect(pin.params).toContain("[redacted]");
      expect(pin.params).toContain("5");
      expect(pinCost).not.toContain("[redacted]");
      expect(pinCost).toMatch(/cost=\d+\.\d+\.\.\d+\.\d+/);
      expect(pinFilter).toContain("[redacted]");
      expect(pinFilter).not.toMatch(/(?<![\w.])1(?![\w.])/);

      const quoted = await explain(db.notes, db.notes.find({ where: { note: NOTE }, limit: 1 }));
      expect(quoted.params).not.toContain(NOTE);
      expect(quoted.plan?.join("\n")).not.toContain("it's");
      expect(quoted.plan?.join("\n")).toContain("'[redacted]'");

      const flags = await explain(
        db.notes,
        db.notes.find({ where: { flags: eq([CODE]) }, limit: 1 }),
      );
      expect(bound(flags.params)).not.toContain(CODE);
      expect(flags.plan?.join("\n")).not.toContain(CODE);

      const doc = await explain(
        db.notes,
        db.notes.find({ where: { doc: eq({ k: SEAL }) }, limit: 1 }),
      );
      expect(bound(doc.params)).not.toContain(SEAL);
      expect(doc.plan?.join("\n")).not.toContain(SEAL);
      expect(doc.plan?.join("\n")).toContain("'[redacted]'");

      const flag = await explain(db.notes, db.notes.find({ where: { flag: false }, limit: 1 }));
      expect(flag.params).toContain("[redacted]");
      expect(flag.params).not.toContain("false");
      expect(flag.plan?.join("\n")).not.toContain("false");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain one redacts a sensitive parameter and the plan text",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const plan = await explain(db.notes, db.notes.one({ where: { token: TOKEN } }));
      expect(plan.params).toContain("[redacted]");
      expect(plan.params).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).toContain("'[redacted]'");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain stream redacts a hidden parameter and the plan text",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const query = db.notes.find({ where: { code: CODE }, limit: 5 });
      const plan = await explain(db.notes, query);
      expect(plan.params).toContain("[redacted]");
      expect(plan.params).not.toContain(CODE);
      expect(plan.plan?.join("\n")).not.toContain(CODE);
      expect(plan.plan?.join("\n")).toContain("'[redacted]'");
      const rows: unknown[] = [];
      for await (const item of query.stream({ batch: 2 })) rows.push(item);
      expect(rows).toHaveLength(1);
      expect(bound(rows)).not.toContain(CODE);
      expect(bound(rows)).toContain(TOKEN);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain search redacts a concealed filter and keeps the search text",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const plan = await explain(
        db.notes,
        db.notes.find({ search: "alpha", where: { seal: SEAL }, limit: 5 }),
      );
      const text = `${bound(plan.params)}\n${plan.plan?.join("\n")}`;
      expect(text).not.toContain(SEAL);
      expect(text).toContain("[redacted]");
      expect(text).toContain("alpha");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain aggregate redacts a sensitive parameter and the plan text",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const plan = await explain(
        db.notes,
        db.notes.aggregate({
          select: { rows: { count: true } },
          where: { token: TOKEN },
          limit: 5,
        }),
      );
      expect(plan.params).toContain("[redacted]");
      expect(plan.params).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).toContain("'[redacted]'");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "explain raw redacts a sensitive parameter and the plan text",
  async () => {
    await withDb(async (db) => {
      await db.notes.insert(row("n1", LABEL));
      const query = db.notes.find({ where: { token: TOKEN }, limit: 1 });
      const plan = await explain(db.notes, query);
      expect(plan.params).toContain("[redacted]");
      expect(plan.params).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).not.toContain(TOKEN);
      expect(plan.plan?.join("\n")).toContain("'[redacted]'");
      const read = await raw(
        db.notes,
        Peek,
        "read",
        fragment`select ${ident("id")}, ${ident("label")} from notes where ${ident("token")} = ${TOKEN}`,
      );
      expect(read.map((item) => item.id)).toEqual(["n1"]);
      expect(bound(read)).not.toContain(CODE);
    });
  },
  30_000,
);
