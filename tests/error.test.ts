/**
 * OkmError, nearest names, the doctor registry, and Postgres mapping.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { DriverError, outcomeUnknown, timedOut } from "../src/adapters/error.js";
import { OkmError, safe } from "../src/contracts/index.js";
import { nearestName, throwNamed } from "../src/contracts/internal.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { refuseMissingValidation } from "../src/runtime/validate/closed.js";
import { ERROR_DOCS, errorDoc } from "../src/tooling/errors/registry.js";

const SPEC_CODES = [
  "OKM1012",
  "OKM1020",
  "OKM1021",
  "OKM1022",
  "OKM1023",
  "OKM1024",
  "OKM1025",
  "OKM1026",
  "OKM1027",
  "OKM1030",
  "OKM1040",
  "OKM1051",
  "OKM1052",
  "OKM1060",
  "OKM1061",
  "OKM1101",
  "OKM1102",
  "OKM1104",
  "OKM1105",
  "OKM1110",
  "OKM1111",
  "OKM1120",
  "OKM1121",
  "OKM1122",
  "OKM1123",
  "OKM1124",
  "OKM1130",
  "OKM1190",
  "OKM1191",
  "OKM1200",
  "OKM1201",
  "OKM1210",
  "OKM1401",
  "OKM1510",
  "OKM1511",
  "OKM1512",
  "OKM1513",
  "OKM1514",
  "OKM1515",
  "OKM1516",
  "OKM1517",
  "OKM1518",
  "OKM1519",
  "OKM1520",
  "OKM1521",
  "OKM1522",
  "OKM1523",
  "OKM1524",
  "OKM1525",
  "OKM1526",
  "OKM1527",
  "OKM1528",
  "OKM1529",
  "OKM1530",
  "OKM1531",
  "OKM1532",
  "OKM1533",
  "OKM1534",
  "OKM1535",
  "OKM1536",
  "OKM1537",
  "OKM1538",
  "OKM1539",
  "OKM1540",
  "OKM1541",
  "OKM1542",
  "OKM1543",
  "OKM1544",
  "OKM1545",
  "OKM1601",
  "OKM1701",
  "OKM1702",
  "OKM1704",
  "OKM1705",
  "OKM1706",
  "OKM1707",
  "OKM1801",
  "OKM1802",
  "OKM1803",
  "OKM1810",
  "OKM1811",
  "OKM1812",
  "OKM1813",
  "OKM1814",
  "OKM1820",
  "OKM1821",
  "OKM1822",
  "OKM1823",
  "OKM1824",
  "OKM1825",
  "OKM1830",
  "OKM1840",
  "OKM1841",
  "OKM1842",
  "OKM1843",
  "OKM1844",
  "OKM1845",
  "OKM1846",
  "OKM1850",
  "OKM1851",
  "OKM1852",
  "OKM1853",
] as const;

test("categories, statuses, match, and safe follow spec 14", async () => {
  const unique = new OkmError("unique", "Unique violation on users.email (email_taken)", {
    kind: "unique",
    table: "users",
    columns: ["email"],
    fieldReason: "email_taken",
  });
  expect(unique.category).toBe("conflict");
  expect(unique.summary).toBe(unique.message);
  expect(unique.retryable).toBe(false);
  expect(unique.fields()).toEqual({ email: "email_taken" });
  expect(unique.fields()).toBe(unique.fields());
  expect(unique.toHttp()).toEqual({
    status: 409,
    body: {
      code: "unique",
      reason: unique.summary,
      fields: { email: "email_taken" },
    },
  });
  expect(unique.toHttp({ conflict: 400 }).status).toBe(400);
  expect(unique.log()).toEqual({
    name: "OkmError",
    code: "unique",
    kind: "unique",
    category: "conflict",
    summary: unique.summary,
    retryable: false,
    batchIndex: null,
    fix: unique.fix,
    fields: { email: "email_taken" },
    table: "users",
    columns: ["email"],
  });

  const timed = new OkmError("timeout", "The call timed out", { kind: "timeout" });
  expect(timed.category).toBe("transient");
  expect(timed.retryable).toBe(true);
  expect(timed.toHttp().status).toBe(503);

  const cancelled = new OkmError("cancelled", "The call was cancelled", { kind: "cancelled" });
  expect(cancelled.retryable).toBe(false);

  const unknown = new OkmError("OKM1401", "The commit outcome is unknown");
  expect(unknown.kind).toBe("outcome_unknown");
  expect(unknown.retryable).toBe(false);
  expect(unknown.fix.summary).toContain("idempotency key");
  expect(unknown.toHttp().status).toBe(500);

  const acquire = new OkmError(
    "OKM1846",
    "Timed out waiting for a connection. This pool did not hand one out within timeouts.acquire.",
  );
  expect(acquire.kind).toBe("timeout");
  expect(acquire.retryable).toBe(true);

  const matched = unique.match({
    input: () => "input",
    conflict: (error) => error.fields().email,
    _: (error) => error.toHttp().status,
  });
  expect(matched).toBe("email_taken");
  const fell = timed.match({
    input: () => "input",
    _: (error) => error.kind,
  });
  expect(fell).toBe("timeout");

  const ok = await safe(Promise.resolve(1));
  expect(ok).toEqual({ ok: true, value: 1 });
  const failed = await safe(Promise.reject(unique));
  if (failed.ok) throw new Error("expected a failure");
  expect(failed.error).toBe(unique);
  const plain = await safe(Promise.reject(new Error("Key (email)=(ada@example.com) already")));
  if (plain.ok) throw new Error("expected a failure");
  expect(plain.error.kind).toBe("driver");
  expect(plain.error.message.includes("ada@example.com")).toBe(false);
});

test("OkmError.is narrows kind and table", () => {
  const error = new OkmError("unique", "Unique violation", {
    kind: "unique",
    table: "users",
    columns: ["email"],
  });
  expect(OkmError.is(error, "unique")).toBe(true);
  expect(OkmError.is(error, "unique", "users")).toBe(true);
  expect(OkmError.is(error, "unique", "tasks")).toBe(false);
  expect(OkmError.is(error, "not_null")).toBe(false);
  expect(OkmError.is(new Error("no"), "unique")).toBe(false);
});

test("nearest names hint unknown tables, fields, and options", () => {
  expect(nearestName("dueAt", ["title", "dueAt"])).toBeUndefined();
  expect(nearestName("dueat", ["title", "dueAt"])).toBe("dueAt");
  expect(nearestName("duAt", ["title", "dueAt"])).toBe("dueAt");
  expect(nearestName("zzzz", ["dueAt", "title"])).toBeUndefined();

  const users = table("users", { id: id(), email: text() });
  const tasks = table("tasks", {
    id: id(),
    ownerId: text().references("user"),
  });
  expect(() => schema({ tables: [users, tasks] })).toThrow(OkmError);
  try {
    schema({ tables: [users, tasks] });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1020");
      expect(error.message).toContain("Accepted names:");
      expect(error.message).toContain("Did you mean `users`?");
      expect(error.fix.suggestion).toBe("users");
    }
  }

  expect(() => table("tasks", { id: id() }, { preset: true } as never)).toThrow(
    /Did you mean `presets`\?/,
  );
  expect(() => table("tasks", { id: id() }, { preset: true } as never)).toThrow(
    /Accepted options:/,
  );

  expect(() =>
    throwNamed("OKM1020", "zzzz", ["users"], "Table zzzz is not in the schema."),
  ).toThrow("Table zzzz is not in the schema.");
});

test("mapPostgresError reads SQLSTATE, constraint names, and batchIndex", () => {
  const unique = mapPostgresError(
    new DriverError("duplicate key value violates unique constraint", {
      sqlstate: "23505",
      constraint: "users_email_taken_key",
      table: "users",
      detail: "Key (email)=(ada@example.com) already exists.",
      batchIndex: 1,
    }),
  );
  expect(unique.kind).toBe("unique");
  expect(unique.summary).toBe("Unique violation on users.email (email_taken)");
  expect(unique.fields()).toEqual({ email: "email_taken" });
  expect(unique.batchIndex).toBe(1);
  expect(unique.values()).toBeUndefined();
  expect(JSON.stringify(unique)).not.toContain("ada@example.com");

  const kept = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: "users_email_taken_key",
      table: "users",
      detail: "Key (email)=(ada@example.com) already exists.",
    }),
    { includeValues: true },
  );
  expect(kept.values()).toEqual({ email: "ada@example.com" });
  expect(kept.message.includes("ada@example.com")).toBe(false);
  expect(JSON.stringify(kept.log())).not.toContain("ada@example.com");

  const atCommit = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: "users_email_key",
      table: "users",
      detail: "Key (email)=(ada@example.com) already exists.",
      batchIndex: null,
    }),
  );
  expect(atCommit.batchIndex).toBe(null);
  expect(atCommit.fields()).toEqual({ email: "email" });

  expect(mapPostgresError(timedOut()).kind).toBe("timeout");
  expect(mapPostgresError(timedOut()).retryable).toBe(true);
  const lost = mapPostgresError(outcomeUnknown());
  expect(lost.code).toBe("OKM1401");
  expect(lost.kind).toBe("outcome_unknown");
  expect(lost.retryable).toBe(false);
  expect(lost.fix.summary).toContain("idempotency key");
  expect(lost.batchIndex).toBe(null);

  expect(
    mapPostgresError(new DriverError("cancel", { sqlstate: "57014", kind: "cancelled" })).kind,
  ).toBe("cancelled");
  expect(mapPostgresError(new DriverError("timeout", { sqlstate: "57014" })).kind).toBe("timeout");
  expect(mapPostgresError(new DriverError("closed", {})).kind).toBe("driver");
  expect(mapPostgresError(new DriverError("The pool is closed.")).kind).toBe("unavailable");
  expect(mapPostgresError(unique)).toBe(unique);
});

test("the error registry lists every spec 21 code and stays off the runtime entry", () => {
  expect(ERROR_DOCS.map((doc) => doc.code)).toEqual([...SPEC_CODES]);
  for (const doc of ERROR_DOCS) {
    expect(doc.title.length).toBeGreaterThan(0);
    expect(doc.title.length).toBeLessThan(40);
    expect(doc.summary.length).toBeGreaterThan(doc.title.length);
    expect(doc.fix.length).toBeGreaterThan(0);
    expect(errorDoc(doc.code)).toBe(doc);
  }

  const root = repoRoot();
  const entry = readFileSync(join(root, "src/contracts/index.ts"), "utf8");
  const errorSource = readFileSync(join(root, "src/contracts/error.ts"), "utf8");
  expect(entry.includes("error-registry")).toBe(false);
  expect(entry.includes("tooling/errors")).toBe(false);
  expect(errorSource.includes("ERROR_DOCS")).toBe(false);
  expect(errorSource.includes("idempotency key")).toBe(true);
});

test("OKM1201 uses the registry sentence", () => {
  const doc = errorDoc("OKM1201");
  let failed: OkmError | undefined;
  try {
    refuseMissingValidation();
  } catch (error) {
    if (error instanceof OkmError) failed = error;
    else throw error;
  }
  if (failed === undefined || doc === undefined) throw new Error("OKM1201 was not thrown");
  expect(failed.code).toBe("OKM1201");
  expect(failed.kind).toBe("invalid");
  expect(failed.category).toBe("input");
  expect(failed.message).toBe(doc.summary);
  expect(failed.fix.summary).toBe(doc.fix);
  expect(failed.message).toBe("Validation is enabled but `okmodel/validate` was not imported.");
});

test("registered table columns narrow OkmError.is", () => {
  const proc = Bun.spawnSync(
    [
      "bunx",
      "tsc",
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(repoRoot(), "tests/fixtures/errors"),
    ],
    { cwd: repoRoot(), stdout: "pipe", stderr: "pipe" },
  );
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  expect(proc.exitCode, output).toBe(0);
});
