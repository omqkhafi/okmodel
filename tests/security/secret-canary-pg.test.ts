/**
 * Sensitive and hidden values stay out of every public output.
 *
 * Three columns, three canary prefixes:
 * - `token` is `.sensitive()`. A read returns it. That is the only allowed
 *   channel for that prefix.
 * - `code` is `hidden({ filterable: true })`. It stays off the row. `where`
 *   and `orderBy` may name it. Observers, errors, cursors, and `explain()`
 *   must not show the value.
 * - `seal` is `.hidden({ filterable: true }).sensitive()`. Same as `code`,
 *   and redacted because it is sensitive. `filterable` is set so `page()`
 *   can `orderBy` it. A hidden column without `filterable` refuses `orderBy`
 *   before a value is bound (`raw.hidden` covers that refusal).
 *
 * `ledger.note` is an ordinary column. The client sets `errors.includeValues`.
 * The prefix may appear in the returned row and in `values()`. The handbook
 * also keeps bound parameters on `error.cause`, and `onQuery`, read
 * `inspect()`, and `explain()` echo a parameter that is not hidden or
 * sensitive. Those ledger hits stay in `KNOWN_LEAKS` until that is confirmed.
 *
 * One concealed-column gap stays in the same list. `archive` has `sql()` and
 * no `inspect()`, so that plan is recorded on the `inspect` channel and still
 * returns the bound token. Write `inspect()` and `explain()` redact hidden
 * and sensitive values. `explain()` sends the real parameters, then replaces
 * those values in `params` and in the plan text. An ordinary column stays.
 *
 * Returned rows may contain `token`. A root `select` that names `code` or
 * `seal` may contain those too. Page cursors, observer events, `onQuery`
 * parameters, error message / cause / `values()` / `log()`, and
 * `okm doctor --bundle` did not contain a concealed canary.
 *
 * `KNOWN_LEAKS` is the product-bug list. The test fails when a run disagrees
 * with it, so a new leak is not silent and a fixed one has to leave the list.
 * This file does not change production code.
 *
 * `testing()` does not accept `onQuery`. The factory case records the
 * returned row and the thrown error. Every other database operation records
 * `onQuery` with `params: true`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { expect, test } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgresSchema } from "../../packages/harness/src/postgres.js";
import { primaryUrl } from "../../packages/harness/src/topology.js";
import { open } from "../../src/adapters/pg/postgresjs.js";
import { OkmError } from "../../src/contracts/error.js";
import { renderCatalog } from "../../src/dialects/pg/ddl.js";
import {
  arr,
  explain,
  fragment,
  ident,
  inc,
  json,
  many,
  raw,
  schema,
  t,
  table,
} from "../../src/dialects/pg/index.js";
import type { ExplainResult } from "../../src/dialects/pg/ops/lane.js";
import { connect } from "../../src/runtime/pg/postgresjs.js";
import {
  queryObserver,
  writeObserver,
  type QueryObserver,
  type WriteObserver,
} from "../../src/runtime/observe.js";
import type { ObserveEvent, QueryEvent } from "../../src/runtime/observe-types.js";
import type { Connected } from "../../src/runtime/types.js";
import { archivable, versioned } from "../../src/runtime/traits/index.js";
import { testing } from "../../src/tooling/testing/index.js";
import { repoRoot } from "../../scripts/root.js";

const CANARY = {
  token: "okmcanary-token-7f3a9c2e",
  code: "okmcanary-code-b41e2d18",
  seal: "okmcanary-seal-91c0e84a",
  plain: "okmcanary-plain-55aa0193",
} as const;

type Column = keyof typeof CANARY;

type Channel =
  | "row"
  | "error.message"
  | "error.cause"
  | "error.params"
  | "error.values"
  | "error.log"
  | "logger"
  | "onQuery"
  | "observer"
  | "cursor"
  | "explain.text"
  | "explain.params"
  | "explain.plan"
  | "inspect"
  | "doctor";

type Leak = {
  readonly op: string;
  readonly channel: Channel;
  readonly column: Column;
};

/**
 * Exposures the Postgres run still produces.
 *
 * Each line is one operation, one channel, and one column. A change fails
 * the test. Ledger rows are the non-sensitive `includeValues` echo described
 * above. `archive` is the remaining concealed value, on `sql()`.
 */
const KNOWN_LEAKS: readonly Leak[] = [
  { op: "archive", channel: "inspect", column: "token" },
  { op: "ledger.duplicate", channel: "error.cause", column: "plain" },
  { op: "ledger.duplicate", channel: "error.params", column: "plain" },
  { op: "ledger.duplicate", channel: "onQuery", column: "plain" },
  { op: "ledger.find", channel: "explain.params", column: "plain" },
  { op: "ledger.find", channel: "explain.plan", column: "plain" },
  { op: "ledger.find", channel: "inspect", column: "plain" },
  { op: "ledger.find", channel: "onQuery", column: "plain" },
  { op: "ledger.insert", channel: "onQuery", column: "plain" },
];

const slips = table("slips", {
  id: t.text().primaryKey(),
  vaultId: t.text().nullable().references("vault"),
  title: t.text(),
});

const ledger = table("ledger", {
  id: t.text().primaryKey(),
  note: t.text().unique(),
});

const vault = table(
  "vault",
  {
    id: t.text().primaryKey(),
    label: t.text().unique(),
    token: t.text().sensitive().unique(),
    code: t.text().hidden({ filterable: true }).unique(),
    seal: t.text().hidden({ filterable: true }).sensitive().unique(),
    n: t.integer(),
    flags: t.text().array().hidden({ filterable: true }),
    blob: t.jsonb().nullable().hidden().sensitive(),
    body: t.tsvector().hidden({ filterable: true }),
  },
  {
    traits: [archivable(), versioned()],
    relations: { slips: many("slips", "vaultId") },
  },
);

const app = schema({ casing: "snake", tables: [vault, slips, ledger] });

type Db = Connected<typeof app>;

type Allow = {
  readonly row?: readonly Column[];
  readonly values?: readonly Column[];
};

type Watch = {
  readonly onWrite: WriteObserver;
  readonly onQuery: QueryObserver;
  readonly events: ObserveEvent[];
  readonly queries: QueryEvent[];
  readonly committed: { readonly unit: string; readonly writes: readonly unknown[] }[];
  readonly rolledBack: { readonly unit: string }[];
  readonly unknown: { readonly unit: string; readonly writes: readonly unknown[] }[];
  readonly errors: unknown[];
  flush(): Promise<void>;
};

const gate = await loadPostgresGate();

const ROW_TOKEN: Allow = { row: ["token"] };
const ROW_SELECTED: Allow = { row: ["token", "code", "seal"] };
const PLAIN: Allow = { row: ["plain"], values: ["plain"] };

function tokenOf(id: string): string {
  return `${CANARY.token}-${id}`;
}

function codeOf(id: string): string {
  return `${CANARY.code}-${id}`;
}

function sealOf(id: string): string {
  return `${CANARY.seal}-${id}`;
}

function plainOf(id: string): string {
  return `${CANARY.plain}-${id}`;
}

function vaultRow(id: string, label: string) {
  return {
    id,
    label,
    token: tokenOf(id),
    code: codeOf(id),
    seal: sealOf(id),
    n: 1,
    flags: [] as string[],
    body: "'alpha':1",
  };
}

function dump(value: unknown): string {
  return inspect(value, { depth: 12, maxArrayLength: 200, maxStringLength: 20_000 });
}

function watch(): Watch {
  const events: ObserveEvent[] = [];
  const queries: QueryEvent[] = [];
  const committed: Watch["committed"][number][] = [];
  const rolledBack: Watch["rolledBack"][number][] = [];
  const unknown: Watch["unknown"][number][] = [];
  const errors: unknown[] = [];
  const onWrite = writeObserver({
    onEvent: (event) => void events.push(event),
    committed: (unit) => void committed.push(unit),
    rolledBack: (unit) => void rolledBack.push(unit),
    unknown: (unit) => void unknown.push(unit),
    onObserverError: (error) => void errors.push(error),
  });
  const onQuery = queryObserver({
    query: (event) => void queries.push(event),
    params: true,
    onObserverError: (error) => void errors.push(error),
  });
  return {
    onWrite,
    onQuery,
    events,
    queries,
    committed,
    rolledBack,
    unknown,
    errors,
    async flush() {
      await onWrite.flush();
      await onQuery.flush();
    },
  };
}

function cursorText(token: string | null): string {
  if (token === null || token.length === 0) return "";
  try {
    const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return `${token}\n${new TextDecoder().decode(bytes)}`;
  } catch {
    return token;
  }
}

const PARAM_KEYS = [
  "parameters",
  "args",
  "detail",
  "where",
  "internalQuery",
  "query",
  "hint",
  "message",
] as const;

function paramText(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return dump(cause);
  const picked: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    if (key in cause) picked[key] = Reflect.get(cause, key);
  }
  const nested = Reflect.get(cause, "cause");
  if (typeof nested === "object" && nested !== null) picked.nested = paramText(nested);
  return dump(picked);
}

function errorText(error: unknown): {
  readonly message: string;
  readonly cause: string;
  readonly params: string;
  readonly values: string;
  readonly log: string;
} {
  if (!(error instanceof OkmError)) {
    const text = dump(error);
    return { message: text, cause: text, params: text, values: "", log: text };
  }
  return {
    message: `${error.name}: ${error.message}\n${String(error)}`,
    cause: dump(error.cause),
    params: paramText(error.cause),
    values: dump(error.values() ?? null),
    log: dump({ log: error.log(), http: error.toHttp(), fields: error.fields() }),
  };
}

function leakKey(item: Leak): string {
  return `${item.op}\u0000${item.channel}\u0000${item.column}`;
}

function stable(items: readonly Leak[]): Leak[] {
  const seen = new Set<string>();
  const out: Leak[] = [];
  for (const item of items) {
    const key = leakKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((left, right) => leakKey(left).localeCompare(leakKey(right)));
  return out;
}

function paste(items: readonly Leak[]): string {
  return items
    .map(
      (item) =>
        `  { op: ${JSON.stringify(item.op)}, channel: ${JSON.stringify(item.channel)}, column: ${JSON.stringify(item.column)} },`,
    )
    .join("\n");
}

function scan(
  text: string,
  op: string,
  channel: Channel,
  allow: Allow | undefined,
  into: Leak[],
): void {
  const columns = Object.keys(CANARY) as Column[];
  for (const column of columns) {
    if (channel === "row" && allow?.row?.includes(column) === true) continue;
    if (channel === "error.values" && allow?.values?.includes(column) === true) continue;
    if (text.includes(CANARY[column])) into.push({ op, channel, column });
  }
}

type Surface = {
  readonly bag: Watch;
  readonly logs: string[];
};

class Peek {
  id = "";
  label = "";
}

postgresTest(
  gate,
  "canaries stay out of public outputs except returned columns and includeValues().values()",
  async () => {
    const leaks: Leak[] = [];
    const broken: string[] = [];
    const versions = new Map<string, number>();

    const note = (op: string, channel: Channel, text: string, allow?: Allow): void => {
      scan(text, op, channel, allow, leaks);
    };

    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const seen: Surface = { bag: watch(), logs: [] };
      const valued: Surface = { bag: watch(), logs: [] };
      const db: Db = connect(primaryUrl(), {
        schema: app,
        searchPath: schemaName,
        max: 4,
        onWrite: seen.bag.onWrite,
        onQuery: seen.bag.onQuery,
        logger: {
          error(entry) {
            seen.logs.push(`${entry.code} ${entry.summary}`);
          },
        },
      });
      const ledgers: Db = connect(primaryUrl(), {
        schema: app,
        searchPath: schemaName,
        max: 1,
        onWrite: valued.bag.onWrite,
        onQuery: valued.bag.onQuery,
        logger: {
          error(entry) {
            valued.logs.push(`${entry.code} ${entry.summary}`);
          },
        },
        errors: { includeValues: true },
      });
      let surface = seen;

      const clear = (): void => {
        surface.bag.events.length = 0;
        surface.bag.queries.length = 0;
        surface.bag.committed.length = 0;
        surface.bag.rolledBack.length = 0;
        surface.bag.unknown.length = 0;
        surface.bag.errors.length = 0;
        surface.logs.length = 0;
      };

      const finish = async (op: string, allow?: Allow): Promise<void> => {
        await surface.bag.flush();
        note(op, "onQuery", dump(surface.bag.queries), allow);
        note(
          op,
          "observer",
          dump({
            events: surface.bag.events,
            committed: surface.bag.committed,
            rolledBack: surface.bag.rolledBack,
            unknown: surface.bag.unknown,
            errors: surface.bag.errors,
          }),
          allow,
        );
        note(op, "logger", surface.logs.join("\n"), allow);
        if (op === "insert" && surface.bag.queries.length === 0) {
          broken.push("insert sent no onQuery event, so parameter redaction was not observed");
        }
      };

      const recordError = (op: string, error: unknown, allow?: Allow): void => {
        const text = errorText(error);
        note(op, "error.message", text.message, allow);
        note(op, "error.cause", text.cause, allow);
        note(op, "error.params", text.params, allow);
        note(op, "error.values", text.values, allow);
        note(op, "error.log", text.log, allow);
      };

      async function step(
        op: string,
        run: () => Promise<unknown>,
        options?: { readonly allow?: Allow; readonly throw?: boolean },
      ): Promise<unknown> {
        clear();
        let value: unknown;
        let thrown: unknown;
        try {
          value = await run();
        } catch (error) {
          thrown = error;
          recordError(op, error, options?.allow);
          if (options?.throw !== true) {
            broken.push(`${op} threw: ${error instanceof Error ? error.message : dump(error)}`);
          }
        }
        await finish(op, options?.allow);
        if (options?.throw === true && thrown === undefined) broken.push(`${op} did not throw`);
        if (thrown === undefined) note(op, "row", dump(value), options?.allow);
        return thrown === undefined ? value : thrown;
      }

      async function planRead(op: string, query: object): Promise<void> {
        const handle = query as {
          inspect(): Promise<unknown>;
        };
        note(op, "inspect", dump(await handle.inspect()));
        const plan: ExplainResult = await explain(db.vault, query);
        if (plan.plan === null) broken.push(`${op} explain() did not run (plan is null)`);
        note(op, "explain.text", plan.text);
        note(op, "explain.params", dump(plan.params));
        note(op, "explain.plan", dump(plan.plan));
      }

      async function planWrite(op: string, write: object): Promise<void> {
        const inspectPlan = Reflect.get(write, "inspect");
        const sqlPlan = Reflect.get(write, "sql");
        const read =
          typeof inspectPlan === "function"
            ? inspectPlan
            : typeof sqlPlan === "function"
              ? sqlPlan
              : undefined;
        if (read === undefined) {
          broken.push(`${op} has no inspect() or sql()`);
          return;
        }
        note(op, "inspect", dump(await (read as () => Promise<unknown>).call(write)));
      }

      const remember = (value: unknown): void => {
        const rows = Array.isArray(value) ? value : [value];
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue;
          const id = Reflect.get(row, "id");
          const version = Reflect.get(row, "version");
          if (typeof id === "string" && typeof version === "number") versions.set(id, version);
        }
      };

      const take = (id: string): number => {
        const current = versions.get(id) ?? 1;
        versions.set(id, current + 1);
        return current;
      };

      try {
        await db.connected;
        await ledgers.connected;

        remember(
          await step("insert", () => db.vault.insert(vaultRow("v1", "alpha")), {
            allow: ROW_TOKEN,
          }),
        );
        remember(
          await step(
            "insert.list",
            () =>
              db.vault.insert([
                vaultRow("v2", "bravo"),
                vaultRow("v3", "charlie"),
                vaultRow("v4", "delta"),
              ]),
            { allow: ROW_TOKEN },
          ),
        );

        await step(
          "find",
          async () => {
            const query = db.vault.find({
              where: { token: tokenOf("v1"), code: codeOf("v1"), seal: sealOf("v1") },
              limit: 5,
            });
            await planRead("find", query);
            return query;
          },
          { allow: ROW_TOKEN },
        );

        await step(
          "one",
          async () => {
            const query = db.vault.one({ where: { token: tokenOf("v1") } });
            await planRead("one", query);
            return query;
          },
          { allow: ROW_TOKEN },
        );

        for (const column of ["code", "seal", "token"] as const) {
          await step(
            `page.${column}`,
            async () => {
              const orderBy = { [column]: "asc" } as const;
              const query = db.vault.page({ orderBy, limit: 1 });
              await planRead(`page.${column}`, query);
              const page = (await query) as {
                readonly items: readonly unknown[];
                readonly next: string | null;
              };
              if (page.next === null) broken.push(`page.${column} did not return a cursor`);
              note(`page.${column}`, "cursor", cursorText(page.next));
              return page.items;
            },
            { allow: ROW_TOKEN },
          );
        }

        await step(
          "stream",
          async () => {
            const query = db.vault.find({ where: { code: codeOf("v1") }, limit: 5 });
            await planRead("stream", query);
            const rows: unknown[] = [];
            for await (const row of query.stream({ batch: 2 })) rows.push(row);
            return rows;
          },
          { allow: ROW_TOKEN },
        );

        await step("aggregate", async () => {
          const query = db.vault.aggregate({
            select: { rows: { count: true }, total: { sum: "n" } },
            where: { token: tokenOf("v1") },
            limit: 5,
          });
          await planRead("aggregate", query);
          return query;
        });

        await step(
          "aggregate.hidden",
          () =>
            db.vault.aggregate({
              groupBy: ["seal"],
              select: { rows: { count: true } },
              where: { seal: sealOf("v1") },
              limit: 5,
            } as never),
          { throw: true },
        );

        await step(
          "search",
          async () => {
            const query = db.vault.find({
              search: "alpha",
              where: { seal: sealOf("v1") },
              limit: 5,
            });
            await planRead("search", query);
            return query;
          },
          { allow: ROW_TOKEN },
        );

        await step(
          "find.select-hidden",
          async () => {
            const query = db.vault.find({
              select: ["id", "token", "code", "seal"] as never,
              where: { id: "v1" },
              limit: 1,
            });
            await planRead("find.select-hidden", query);
            return query;
          },
          { allow: ROW_SELECTED },
        );

        const edited = await step(
          "update.id",
          async () => {
            const write = db.vault.update(
              {
                where: { id: "v1" },
                set: {
                  token: tokenOf("v1"),
                  code: codeOf("v1"),
                  seal: sealOf("v1"),
                  label: "alpha-2",
                },
                version: take("v1"),
              },
              { returning: true },
            );
            await planWrite("update.id", write);
            return write;
          },
          { allow: ROW_TOKEN },
        );
        remember(edited);

        await step("update.filter", async () => {
          const write = db.vault.update({
            where: { code: codeOf("v1") },
            set: { label: "alpha-3" },
            version: take("v1"),
          });
          await planWrite("update.filter", write);
          return write;
        });

        const claimed = await step(
          "claim",
          async () => {
            const write = db.vault.update({
              where: { label: "delta" },
              set: { label: "claimed" },
              limit: 1,
              lock: "skip",
              version: "any",
            });
            await planWrite("claim", write);
            return write;
          },
          { allow: ROW_TOKEN },
        );
        remember(claimed);

        await step("atomic", async () => {
          const write = db.vault.update({
            where: { id: "v1" },
            set: {
              n: inc(2),
              flags: arr.append(codeOf("v1")),
              blob: json.set(["k"], sealOf("v1")),
            },
            version: take("v1"),
          });
          await planWrite("atomic", write);
          return write;
        });

        await step(
          "find.after-atomic",
          async () => {
            const query = db.vault.find({ where: { id: "v1" }, limit: 1 });
            await planRead("find.after-atomic", query);
            return query;
          },
          { allow: ROW_TOKEN },
        );

        await step("delete", async () => {
          const write = db.vault.delete({ where: { seal: sealOf("v3") } });
          await planWrite("delete", write);
          return write;
        });

        await step("archive", async () => {
          const write = db.vault.archive({ where: { token: tokenOf("v2") } });
          await planWrite("archive", write);
          return write;
        });

        await step("sync", async () => {
          await db.slips.insert({ id: "s1", vaultId: null, title: "slip" });
          const handle = db.vault.sync("v1", "slips", ["s1"]);
          note("sync", "inspect", dump(await handle.sql()));
          return handle;
        });

        await step(
          "db.batch",
          async () => {
            const inserted = db.vault.insert(vaultRow("v6", "foxtrot"));
            const second = db.vault.insert(vaultRow("v8", "hotel"));
            await planWrite("db.batch", inserted);
            await planWrite("db.batch", second);
            return db.batch([inserted, second]);
          },
          { allow: ROW_TOKEN },
        );

        await step("tx", async () =>
          db.tx(async (tx) => {
            const write = tx.vault.update({
              where: { id: "v1" },
              set: { token: tokenOf("v1"), label: "in-tx" },
              version: take("v1"),
            });
            await planWrite("tx", write);
            return write;
          }),
        );

        const txBatched = await step(
          "tx.batch",
          () =>
            db.tx(async (tx) => {
              const inserted = tx.vault.insert(vaultRow("v7", "golf"));
              const updated = tx.vault.update(
                { where: { id: "v1" }, set: { label: "tx-batch" }, version: take("v1") },
                { returning: true },
              );
              await planWrite("tx.batch", inserted);
              await planWrite("tx.batch", updated);
              return tx.batch([inserted, updated]);
            }),
          { allow: ROW_TOKEN },
        );
        remember(Array.isArray(txBatched) ? txBatched[1] : undefined);

        await step(
          "first-or-create",
          async () => {
            const write = db.vault.insert(vaultRow("fc", "once"), {
              onConflict: { on: "label", return: true },
            });
            await planWrite("first-or-create", write);
            return write;
          },
          { allow: ROW_TOKEN },
        );
        await step(
          "first-or-create.again",
          async () => {
            const write = db.vault.insert(
              {
                ...vaultRow("fc2", "once"),
                token: tokenOf("fc2"),
                code: codeOf("fc2"),
                seal: sealOf("fc2"),
              },
              { onConflict: { on: "label", return: true } },
            );
            await planWrite("first-or-create.again", write);
            return write;
          },
          { allow: ROW_TOKEN },
        );

        await step("raw", async () => {
          const query = db.vault.find({ where: { token: tokenOf("v1") }, limit: 1 });
          await planRead("raw", query);
          const read = await raw(
            db.vault,
            Peek,
            "read",
            fragment`select ${ident("id")}, ${ident("label")} from vault where ${ident("token")} = ${tokenOf("v1")}`,
          );
          const wrote = await raw(
            db.vault,
            Peek,
            "write",
            fragment`update vault set label = ${"raw-label"} where ${ident("token")} = ${tokenOf("v1")}`,
          );
          return { read, wrote };
        });

        await step(
          "raw.hidden",
          () =>
            raw(
              db.vault,
              Peek,
              "read",
              fragment`select ${ident("id")} from vault where ${ident("code")} = ${codeOf("v1")}`,
            ),
          { throw: true },
        );

        await step(
          "error.token",
          () => db.vault.insert({ ...vaultRow("dup-token", "dup-token"), token: tokenOf("v1") }),
          { throw: true },
        );
        await step(
          "error.code",
          () => db.vault.insert({ ...vaultRow("dup-code", "dup-code"), code: codeOf("v1") }),
          { throw: true },
        );
        await step(
          "error.seal",
          () => db.vault.insert({ ...vaultRow("dup-seal", "dup-seal"), seal: sealOf("v1") }),
          { throw: true },
        );
        await step(
          "error.unknown-key",
          () => db.vault.insert({ ...vaultRow("bad", "bad"), nope: true } as never),
          { throw: true },
        );

        surface = valued;
        await step(
          "ledger.insert",
          () => ledgers.ledger.insert({ id: "l1", note: plainOf("l1") }),
          {
            allow: PLAIN,
          },
        );
        const duplicate = await step(
          "ledger.duplicate",
          () => ledgers.ledger.insert({ id: "l2", note: plainOf("l1") }),
          { allow: PLAIN, throw: true },
        );
        if (
          !(duplicate instanceof OkmError) ||
          !dump(duplicate.values() ?? null).includes(CANARY.plain)
        ) {
          broken.push(
            `ledger.duplicate values() did not keep the plain canary: ${dump(duplicate)}`,
          );
        }
        await step(
          "ledger.find",
          async () => {
            const query = ledgers.ledger.find({ where: { note: plainOf("l1") }, limit: 1 });
            const handle = query as { inspect(): Promise<unknown> };
            note("ledger.find", "inspect", dump(await handle.inspect()));
            const plan = await explain(ledgers.ledger, query);
            if (plan.plan === null) broken.push("ledger.find explain() did not run");
            note("ledger.find", "explain.text", plan.text);
            note("ledger.find", "explain.params", dump(plan.params));
            note("ledger.find", "explain.plan", dump(plan.plan));
            return query;
          },
          { allow: PLAIN },
        );
      } finally {
        await db.close();
        await ledgers.close();
      }
    });

    const database = await createIsolatedDatabase();
    try {
      const harness = await testing(app, { driver: open({ url: database.url, max: 1 }) });
      try {
        const factories = harness.factories({
          vault: () => vaultRow("f1", "factory"),
        });
        const created = await factories.vault.create();
        scan(dump(created), "factory.create", "row", ROW_TOKEN, leaks);
        const manyRows = await factories.vault.createMany(1, vaultRow("f2", "factory-2"));
        scan(dump(manyRows), "factory.createMany", "row", ROW_TOKEN, leaks);
        try {
          await factories.vault.create();
          broken.push("factory.create duplicate did not throw");
        } catch (error) {
          const text = errorText(error);
          scan(text.message, "factory.duplicate", "error.message", undefined, leaks);
          scan(text.cause, "factory.duplicate", "error.cause", undefined, leaks);
          scan(text.params, "factory.duplicate", "error.params", undefined, leaks);
          scan(text.values, "factory.duplicate", "error.values", undefined, leaks);
          scan(text.log, "factory.duplicate", "error.log", undefined, leaks);
        }
      } finally {
        await harness.close();
      }
    } finally {
      await database.close();
    }

    const live = stable(leaks);
    const known = stable(KNOWN_LEAKS);
    if (broken.length > 0 || JSON.stringify(live) !== JSON.stringify(known)) {
      throw new Error(
        [
          broken.length > 0 ? `operations failed:\n${broken.join("\n")}` : "",
          "canary leaks:",
          paste(live),
          known.length > 0 ? `known:\n${paste(known)}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }
  },
  180_000,
);

test(
  "okm doctor --bundle does not contain a canary",
  async () => {
    const root = repoRoot();
    const dir = mkdtempSync(join(tmpdir(), "okm-canary-bundle-"));
    const leaks: Leak[] = [];
    try {
      const schemaText = [
        `import { schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "export const app = schema({",
        "  tables: [",
        '    table("secrets", {',
        `      id: text().primaryKey(),`,
        `      token: text().sensitive().default(${JSON.stringify(tokenOf("doctor"))}),`,
        `      code: text().hidden({ filterable: true }).default(${JSON.stringify(codeOf("doctor"))}),`,
        `      seal: text().hidden({ filterable: true }).sensitive().default(${JSON.stringify(sealOf("doctor"))}),`,
        `      note: text().default(${JSON.stringify(plainOf("doctor"))}),`,
        "    }),",
        "  ],",
        "});",
        "",
      ].join("\n");
      writeFileSync(join(dir, "schema.ts"), schemaText);
      writeFileSync(
        join(dir, "okmodel.config.ts"),
        [
          `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
          "export default defineConfig({",
          '  schema: "./schema.ts",',
          '  migrations: "./migrations",',
          '  database: { url: "postgres://okm:okm@127.0.0.1:1/okm" },',
          "});",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "okm-canary-bundle", dependencies: { postgres: "^3.4.0" } }),
      );
      writeFileSync(join(dir, "bun.lock"), "");
      mkdirSync(join(dir, "node_modules", "postgres"), { recursive: true });
      writeFileSync(
        join(dir, "node_modules", "postgres", "package.json"),
        JSON.stringify({ name: "postgres", version: "3.4.5" }),
      );
      const init = spawnSync("bun", [join(root, "src/tooling/cli.ts"), "generate", "init"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(init.status, init.stderr).toBe(0);
      mkdirSync(join(dir, "migrations"), { recursive: true });
      writeFileSync(
        join(dir, "migrations", "0002_canary.sql"),
        `insert into secrets (id, token, code, seal, note) values ('d', '${tokenOf("sql")}', '${codeOf("sql")}', '${sealOf("sql")}', '${plainOf("sql")}');\n`,
      );
      writeFileSync(join(dir, ".env"), `SECRET=${plainOf("env")}\n`);
      const out = join(dir, "doctor-bundle.json");
      const result = spawnSync(
        "bun",
        [join(root, "src/tooling/cli.ts"), "doctor", "--bundle", "--out", out, "--force-file"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const bundle = readFileSync(out, "utf8");
      const shown = `${result.stdout}\n${result.stderr}\n${bundle}`;
      scan(shown, "doctor.bundle", "doctor", undefined, leaks);
      expect(paste(stable(leaks))).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
