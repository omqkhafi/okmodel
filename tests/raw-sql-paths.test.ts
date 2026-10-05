/**
 * OKM1702 in 0.2: no public runtime path takes raw SQL on a tenant table.
 *
 * The spec makes unverifiable SQL on a tenant table a runtime error (OKM1702)
 * unless it is marked trusted. Typed raw SQL is M2. In 0.2 the only thing called
 * `sql` in the public API is the template that writes a default, a check or an
 * index expression in a schema definition, and the client has no method that takes
 * SQL text. This test fails when that stops being true: a new method on the client
 * or on a table handle, a new place where `sql` or `.unsafe()` reaches the runtime
 * layer, or a `sql` value that a call starts to accept. Whoever adds one must add
 * the OKM1702 check in the same change and update the lists below.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { sql } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { gateApp, TENANT_A } from "./gate-schema.js";

const statements: string[] = [];

const result = { rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] };

const pool = {
  reserve: () =>
    Promise.resolve({
      execute: (text: string) => {
        statements.push(text);
        return Promise.resolve(result);
      },
      batch: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    }),
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: (text: string) => {
    statements.push(text);
    return Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] });
  },
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as unknown as DriverPool;

/** Every string key on an object and its prototype chain. */
function names(value: object): string[] {
  const seen = new Set<string>();
  let current: object | null = value;
  while (current !== null && current !== Object.prototype && current !== Function.prototype) {
    for (const key of Reflect.ownKeys(current)) if (typeof key === "string") seen.add(key);
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...seen].sort();
}

/**
 * The public surface a call can reach, and what each name takes.
 *
 * - Client: table names, `for`, `unscoped(reason)`, `tx`, `batch`, `close`, `connected`,
 *   `table`. `tx` and `batch` take callbacks and builders. None takes SQL text.
 * - Transaction client: the same, plus `advisoryLock(key)` (a key, bound as a parameter),
 *   and `afterCommit(fn)`.
 * - Table: the query and write methods, the archive views, and the presets. They take
 *   objects of field names and values.
 * - Query handle: `sql()` and `inspect()` return the statement; they take nothing.
 */
const CLIENT = ["batch", "close", "connected", "for", "table", "tx", "unscoped"];
const SCOPED_EXTRA = ["batch", "close", "connected", "table", "tx"];
const TX_EXTRA = ["advisoryLock", "afterCommit"];
const TABLE_BASE = [
  "aggregate",
  "archive",
  "count",
  "delete",
  "exists",
  "find",
  "insert",
  "onlyArchived",
  "one",
  "page",
  "restore",
  "update",
  "withArchived",
];
const QUERY = ["all", "catch", "finally", "inspect", "required", "safe", "sql", "stream", "then"];

/** A method name that suggests the caller hands over SQL. */
const RAW_NAMES = /^(raw|query|execute|exec|unsafe|run|literal|fragment|statement|trusted)$/i;

test("the client and the table handles have no method that takes SQL text", async () => {
  const root = connect(pool, { schema: gateApp }) as unknown as Record<string, unknown>;
  const scoped = (root.for as (scope: object) => Record<string, unknown>)({ tenantId: TENANT_A });
  const projects = scoped.projects as Record<string, unknown>;

  // The root client names no tenant table, so nothing on it can reach one without `for()`.
  expect(names(root)).toEqual([...CLIENT, "countries"].sort());
  expect(names(scoped)).toEqual(
    [...SCOPED_EXTRA, "countries", "labels", "orgs", "projectLabels", "projects", "tasks"].sort(),
  );
  // Presets are the table's own and are builders of predicates, not text.
  const presets = names(projects).filter((name) => !TABLE_BASE.includes(name));
  expect(presets.sort()).toEqual(["inOrg", "rich", "starred"]);
  expect(
    names(projects)
      .filter((name) => TABLE_BASE.includes(name))
      .sort(),
  ).toEqual([...TABLE_BASE].sort());

  const query = (projects.find as (options: object) => object)({ limit: 1 });
  expect(names(query)).toEqual(QUERY);
  // `sql()` and `inspect()` report; they do not accept SQL.
  expect((query as { sql: (...args: unknown[]) => unknown }).sql.length).toBe(0);
  expect((query as { inspect: (...args: unknown[]) => unknown }).inspect.length).toBe(0);

  let inside: string[] = [];
  await (scoped.tx as (fn: (t: object) => Promise<void>) => Promise<void>)((t) => {
    inside = names(t);
    return Promise.resolve();
  });
  expect(inside).toEqual(
    [
      ...SCOPED_EXTRA.filter((name) => name !== "tx"),
      ...TX_EXTRA,
      "tx",
      "countries",
      "labels",
      "orgs",
      "projectLabels",
      "projects",
      "tasks",
    ].sort(),
  );

  for (const found of [names(root), names(scoped), names(projects), inside, names(query)].flat()) {
    expect(RAW_NAMES.test(found), `${found} looks like a raw SQL path`).toBe(false);
  }
});

test("a sql`` value in a filter, a row, or an update is refused and nothing is sent", async () => {
  const root = connect(pool, { schema: gateApp }) as unknown as Record<string, unknown>;
  // `any` is justified: the test hands the client values its types refuse, to see what the runtime does.
  // oxlint-disable-next-line typescript/no-explicit-any
  const db = (root.for as (scope: object) => Record<string, any>)({ tenantId: TENANT_A });
  const text = sql`name = name`;
  statements.length = 0;
  const attempts: (() => PromiseLike<unknown>)[] = [
    () => db.projects.find({ where: { name: text }, limit: 1 }),
    () => db.projects.find({ where: text, limit: 1 }),
    () => db.projects.find({ orderBy: text, limit: 1 }),
    () => db.projects.insert({ name: text }),
    () => db.projects.update({ where: { name: "a" }, set: { name: text } }),
    () => db.projects.delete({ where: text }),
  ];
  for (const attempt of attempts) {
    let caught: unknown;
    try {
      await attempt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OkmError);
    // OKM1121 (an object where a value is expected) or OKM1120 (an unknown field), never a run.
    expect(["OKM1120", "OKM1121"]).toContain((caught as OkmError).code);
  }
  // The only statement the pool saw is the server version check at connect.
  expect(statements.filter((text) => !/server_version_num/.test(text))).toEqual([]);
});

/** Source files under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("only the driver adapters hand text to the database; the runtime layer builds Statements", () => {
  const offenders: string[] = [];
  for (const file of sources("src/runtime")) {
    const text = readFileSync(file, "utf8");
    if (/\.unsafe\(|sql\.raw\(|\bunsafe\b\s*\(/.test(text)) offenders.push(`${file}: unsafe`);
    // The `sql` template of `okmodel/pg` is for schema definitions. The runtime layer does not read it.
    if (/\bSqlText\b/.test(text)) offenders.push(`${file}: SqlText`);
    if (/import[^;]*\bsql\b[^;]*from "\.\.\/dialects\/pg\/(?:index|table)\.js"/.test(text)) {
      offenders.push(`${file}: imports the sql template`);
    }
  }
  expect(offenders).toEqual([]);
});
