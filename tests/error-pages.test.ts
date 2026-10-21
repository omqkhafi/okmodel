/**
 * Per-code pages: bypass tokens, offline examples, and the database list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { errorBody } from "../src/tooling/errors/body.js";
import {
  NEEDS_DATABASE,
  NOT_THROWN,
  offlineExample,
  pageExample,
} from "../src/tooling/errors/examples.js";
import { proseProblems, renderErrorPage } from "../src/tooling/errors/page.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";
import { bypassTokensIn } from "../src/tooling/errors/shape.js";
import { errorsSchema, schemaProblems } from "../src/tooling/cli/schema.js";
import { repoRoot } from "../scripts/root.js";

test("registry summary and fix name no bypass", () => {
  const hits: string[] = [];
  for (const doc of ERROR_DOCS) {
    for (const token of bypassTokensIn(doc.summary)) hits.push(`${doc.code} summary ${token}`);
    for (const token of bypassTokensIn(doc.fix)) hits.push(`${doc.code} fix ${token}`);
  }
  expect(hits).toEqual([]);
});

test("every code is an offline pair, needs a database, or is not thrown", async () => {
  const database = [...NEEDS_DATABASE];
  const silent = [...NOT_THROWN];
  const offline: string[] = [];
  const missing: string[] = [];
  for (const doc of ERROR_DOCS) {
    const buckets = [
      offlineExample(doc.code) !== undefined,
      (database as readonly string[]).includes(doc.code),
      (silent as readonly string[]).includes(doc.code),
    ].filter(Boolean).length;
    if (buckets !== 1) missing.push(doc.code);
    if (offlineExample(doc.code) !== undefined) offline.push(doc.code);
  }
  expect(missing).toEqual([]);
  expect(database).toEqual([
    "OKM1520",
    "OKM1521",
    "OKM1522",
    "OKM1707",
    "OKM1708",
    "OKM1801",
    "OKM1802",
    "OKM1803",
    "OKM1811",
    "OKM1814",
    "OKM1821",
    "OKM1825",
    "OKM1547",
    "OKM1548",
    "OKM1549",
    "OKM1841",
    "OKM1842",
    "OKM1843",
    "OKM1844",
    "OKM1846",
    "OKM1851",
    "OKM1855",
    "OKM1856",
    "OKM1857",
    "OKM1858",
    "OKM1554",
    "OKM1555",
  ]);
  expect(silent).toEqual(["OKM1025", "OKM1051", "OKM1110", "OKM1191", "OKM1601"]);
  expect(offline.length + database.length + silent.length).toBe(ERROR_DOCS.length);
  const failed: string[] = [];
  for (const code of offline) {
    const example = offlineExample(code);
    if (example === undefined) {
      failed.push(code);
      continue;
    }
    try {
      await example.check();
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  expect(failed).toEqual([]);
});

test("a database page uses the fixed sentence and prose stays unmarked", () => {
  for (const doc of ERROR_DOCS) {
    const example = pageExample(doc.code);
    const text = renderErrorPage(doc, example);
    expect(proseProblems(doc.code, text)).toEqual([]);
    if ((NEEDS_DATABASE as readonly string[]).includes(doc.code)) {
      expect(text).toContain("Example: needs a database");
    }
  }
});

test("one error object per code matches the errors schema", () => {
  const schema = errorsSchema();
  for (const doc of ERROR_DOCS) {
    const body = errorBody(new OkmError(doc.code, doc.summary, { fix: { summary: doc.fix } }));
    expect(schemaProblems(schema, [body])).toEqual([]);
    expect(body.docs).toBe(`docs/errors/${doc.code}.md`);
    expect(bypassTokensIn(body.summary)).toEqual([]);
    expect(bypassTokensIn(body.fix)).toEqual([]);
  }
  const driver = errorBody(new OkmError("driver", "driver error", { kind: "driver" }));
  expect(Object.keys(driver)).toEqual([
    "code",
    "kind",
    "category",
    "summary",
    "fix",
    "retryable",
    "detail",
  ]);
  expect(driver.summary.includes("driver error")).toBe(false);
  expect(driver.detail?.text).toBe("driver error");
  expect(schemaProblems(schema, [driver])).toEqual([]);
  const bodies = ERROR_DOCS.map((doc) =>
    errorBody(new OkmError(doc.code, doc.summary, { fix: { summary: doc.fix } })),
  );
  const snap = join(repoRoot(), "tests/fixtures/cli-error-bodies.snap.json");
  expect(JSON.stringify(bodies, null, 2) + "\n").toBe(readFileSync(snap, "utf8"));
});
