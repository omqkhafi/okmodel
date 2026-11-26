/**
 * Index options and comments on a real server.
 *
 * One apply covers every new index form and every wired comment kind.
 * Introspection then plans back to zero steps. Each proof title checks
 * that the server stored its feature. A storage change rebuilds the index.
 * COMMENT ON takes ShareUpdateExclusiveLock.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog, CatalogObject } from "../src/contracts/catalog/types.js";
import { index, schema, sql as sqlText, table, t } from "../src/dialects/pg/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { fn, trigger } from "../src/dialects/pg/fn/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { sealAuthored } from "../src/tooling/migrate/drift.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

type Proof = {
  readonly live: Catalog;
  readonly steps: readonly string[];
};

let pending: Promise<Proof> | undefined;

function once(): Promise<Proof> {
  pending ??= runOnce();
  return pending;
}

postgresTest(
  gate,
  "proof:index.covering",
  async () => {
    expect(
      found(
        await once(),
        (object) => object.kind === "index" && object.definition.include !== undefined,
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:index.ordering",
  async () => {
    expect(
      found(
        await once(),
        (object) =>
          object.kind === "index" &&
          object.definition.elements?.some(
            (element) => element.order === "desc" || element.opclass !== undefined,
          ) === true,
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:index.nullsNotDistinct",
  async () => {
    expect(
      found(
        await once(),
        (object) => object.kind === "index" && object.definition.nullsNotDistinct === true,
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:index.storage",
  async () => {
    expect(
      found(
        await once(),
        (object) => object.kind === "index" && object.definition.storage !== undefined,
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.table",
  async () => {
    expect(comment(await once(), "table", "notes")).toBe("Stored notes");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.column",
  async () => {
    expect(comment(await once(), "column", "email")).toBe("Address");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.index",
  async () => {
    expect(comment(await once(), "index", "notes_email_idx")).toBe("Login");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.view",
  async () => {
    expect(comment(await once(), "view", "note_emails")).toBe("Emails");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.matview",
  async () => {
    expect(comment(await once(), "materializedView", "note_kinds")).toBe("Kinds");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.function",
  async () => {
    expect(comment(await once(), "function", "note_touch")).toBe("Touch function");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.trigger",
  async () => {
    expect(comment(await once(), "trigger", "notes_touch")).toBe("Touch");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.sequence",
  async () => {
    expect(
      found(await once(), (object) => object.kind === "sequence" && object.comment === "Surrogate"),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.type",
  async () => {
    expect(comment(await once(), "type", "note_status")).toBe("Lifecycle");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:comment.constraint",
  async () => {
    expect(
      found(
        await once(),
        (object) => object.kind === "constraint" && object.comment === "Email is present",
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "a storage parameter change replaces the index concurrently",
  async () => {
    await using(async (sql) => {
      const first = declared(90);
      await apply(sql, catalog([]), first.catalog);
      const second = declared(70);
      const steps = planMigration({
        before: first.catalog,
        after: second.catalog,
        name: "fill",
      }).steps;
      expect(steps.some((step) => step.sql.includes("create index concurrently"))).toBe(true);
      expect(steps.some((step) => step.sql.includes("rename to"))).toBe(true);
      expect(steps.some((step) => step.sql.toLowerCase().includes("set ("))).toBe(false);
      expect(steps[0]?.sql).toContain("drop index concurrently if exists");
      await sql.unsafe("create index notes_email_cover_okmnew on notes (email)");
      await sql`
        update pg_index
        set indisvalid = false
        where indexrelid = 'notes_email_cover_okmnew'::regclass
      `;
      for (const step of steps) await sql.unsafe(step.sql);
      const leftover = await sql<{ name: string }[]>`
        select c.relname as name
        from pg_class c
        where c.relname = 'notes_email_cover_okmnew'
      `;
      expect(leftover.length).toBe(0);
      const live = await read(sql);
      const sealed = await sealAuthored(queryOf(sql), second.catalog);
      expect(planMigration({ before: live, after: sealed, name: "again" }).steps).toEqual([]);
    });
  },
  180_000,
);

postgresTest(
  gate,
  "comment on takes share update exclusive",
  async () => {
    await using(async (sql) => {
      await sql.unsafe("create table lock_probe (id integer)");
      await sql.unsafe("begin");
      await sql.unsafe("comment on table lock_probe is 'kept'");
      const rows = await sql<{ mode: string }[]>`
        select l.mode
        from pg_locks l
        where l.pid = pg_backend_pid()
          and l.relation = 'lock_probe'::regclass
      `;
      await sql.unsafe("rollback");
      expect(rows.map((row) => row.mode)).toContain("ShareUpdateExclusiveLock");
    });
  },
  60_000,
);

function declared(fillfactor: number) {
  const notes = table(
    "notes",
    {
      id: t.identity({ comment: "Surrogate" }),
      email: t.text().comment("Address"),
      status: t.enum("note_status", ["open", "closed"], "Lifecycle"),
    },
    {
      comment: "Stored notes",
      indexes: (columns) => [
        index(columns.email).unique({ nullsNotDistinct: true }).comment("Login"),
        index(columns.email)
          .where(sqlText`email = 'a@b.c'`)
          .name("notes_email_partial"),
        index(columns.email.desc().nullsLast().ops("text_pattern_ops")).name("notes_email_pattern"),
        index(columns.email).include(columns.id).with({ fillfactor }).name("notes_email_cover"),
        index(sqlText`lower(email)`).name("notes_email_lower"),
      ],
      checks: {
        emailPresent: {
          expression: (columns) => sqlText`((${columns.email} <> ''::text))`,
          comment: "Email is present",
        },
      },
    },
  );
  const touch = fn("note_touch", {
    returns: "trigger",
    language: "plpgsql",
    body: "begin return new; end",
    dependsOn: [notes],
    comment: "Touch function",
  });
  return schema({
    tables: [notes, table("users", { id: t.identity() })],
    views: [
      view("note_emails", {
        columns: [{ name: "email", type: "text", comment: "View mail" }],
        query: "select email from notes",
        comment: "Emails",
      }),
      materializedView("note_kinds", {
        columns: [{ name: "email", type: "text" }],
        query: "select email from notes",
        comment: "Kinds",
      }),
    ],
    functions: [touch],
    triggers: [
      trigger("notes_touch", {
        on: notes,
        timing: "before",
        events: ["update"],
        level: "row",
        calls: touch,
        comment: "Touch",
      }),
    ],
  });
}

async function runOnce(): Promise<Proof> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    const head = declared(90);
    await apply(sql, catalog([]), head.catalog);
    const live = await read(sql);
    const sealed = await sealAuthored(queryOf(sql), head.catalog);
    const steps = planMigration({ before: live, after: sealed, name: "round" }).steps.map(
      (step) => step.sql,
    );
    if (steps.length > 0) throw new Error(steps.join("\n"));
    return { live, steps };
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

async function apply(sql: Sql, before: Catalog, after: Catalog): Promise<void> {
  const plan = planMigration({ before, after, name: "apply" });
  for (const step of plan.steps) await sql.unsafe(step.sql);
}

async function read(sql: Sql): Promise<Catalog> {
  return introspectSchema(queryOf(sql), "public", "public");
}

async function using(body: (sql: Sql) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

function found(proof: Proof, match: (object: CatalogObject) => boolean): boolean {
  return proof.live.objects.some(match);
}

function comment(proof: Proof, kind: CatalogObject["kind"], name: string): string | undefined {
  const object = proof.live.objects.find(
    (item) => item.kind === kind && "name" in item.identity && item.identity.name === name,
  );
  return object?.comment;
}
