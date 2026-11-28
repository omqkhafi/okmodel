/**
 * `GET /api/search` returns the documented JSON. The static index stays on
 * the server.
 */

import { expect, test } from "bun:test";

import { GET } from "../app/api/search/route";
import { searchIndexJson } from "./search-docs";

test("a query returns the documented hit shape", async () => {
  const indexBytes = Buffer.byteLength(searchIndexJson());
  expect(indexBytes).toBeGreaterThan(10_000);

  const extensions = await ask("extensions");
  const trigger = await ask("trigger");
  expect(extensions.bytes).toBeLessThan(indexBytes / 10);
  expect(trigger.bytes).toBeLessThan(indexBytes / 10);
  expect(extensions.body.query).toBe("extensions");
  expect(extensions.body.results.length).toBeGreaterThan(0);
  expect(trigger.body.results.length).toBeGreaterThan(0);
  expect(extensions.body.results.every(isHit)).toBe(true);
  expect(trigger.body.results.every(isHit)).toBe(true);
  expect(extensions.body.results.some((hit) => hit.url.includes("extension"))).toBe(true);
  expect(trigger.body.results.some((hit) => hit.url.includes("trigger"))).toBe(true);
  console.log(`search index bytes ${String(indexBytes)}`);
}, 60_000);

test("an empty query and a query with no matches return an empty list", async () => {
  const missing = await ask("");
  const blank = await ask(undefined);
  const none = await ask("qxqxqxqxqx");
  expect(missing.body.results).toEqual([]);
  expect(blank.body.results).toEqual([]);
  expect(none.body.results).toEqual([]);
  expect(missing.status).toBe(200);
  expect(none.status).toBe(200);
}, 60_000);

test("the search handler's median of 20 warm calls stays a report", async () => {
  await ask("tables");
  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const response = await ask("OKM1101");
    samples.push(performance.now() - started);
    expect(response.status).toBe(200);
    expect(response.body.results[0]?.url).toContain("/docs/reference/errors");
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  console.log(`search median ms ${median.toFixed(2)} of 20`);
}, 60_000);

/** One documented hit. */
interface Hit {
  readonly title: string;
  readonly url: string;
  readonly markdown: string;
  readonly summary: string;
  readonly section: string;
  readonly chip: string;
}

/**
 * Call the route handler.
 *
 * @param query - Search text. Omit it to send no `query` parameter
 */
async function ask(query: string | undefined): Promise<{
  readonly status: number;
  readonly bytes: number;
  readonly body: { readonly query: string; readonly results: readonly Hit[] };
}> {
  const url = new URL("http://localhost/api/search");
  if (query !== undefined) url.searchParams.set("query", query);
  const response = await GET(new Request(url));
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) {
    throw new Error(`expected { results }, got ${text.slice(0, 80)}`);
  }
  return {
    status: response.status,
    bytes: Buffer.byteLength(text),
    body: parsed as { query: string; results: Hit[] },
  };
}

/**
 * A hit has the documented fields.
 *
 * @param hit - One JSON element
 */
function isHit(hit: Hit): boolean {
  return (
    typeof hit.title === "string" &&
    hit.title.length > 0 &&
    typeof hit.url === "string" &&
    hit.url.startsWith("/docs") &&
    typeof hit.markdown === "string" &&
    hit.markdown.includes("/llms.mdx/docs/") &&
    typeof hit.summary === "string" &&
    typeof hit.section === "string" &&
    hit.section.length > 0 &&
    typeof hit.chip === "string"
  );
}
