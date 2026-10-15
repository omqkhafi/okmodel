/**
 * `GET /api/search` returns query hits. The static index stays on the server.
 */

import { expect, test } from "bun:test";
import { createFromSource } from "fumadocs-core/search/server";

import { GET } from "../app/api/search/route";
import { source } from "./source";

test("a query returns hits and a much smaller body than the index", async () => {
  const index = await createFromSource(source).staticGET();
  const indexBytes = Buffer.byteLength(await index.text());
  expect(indexBytes).toBeGreaterThan(500_000);

  const extensions = await ask("extensions");
  const trigger = await ask("trigger");
  expect(extensions.bytes).toBeLessThan(indexBytes / 10);
  expect(trigger.bytes).toBeLessThan(indexBytes / 10);
  expect(extensions.hits.length).toBeGreaterThan(0);
  expect(trigger.hits.length).toBeGreaterThan(0);
  expect(extensions.hits.every(isHit)).toBe(true);
  expect(trigger.hits.every(isHit)).toBe(true);
  expect(extensions.hits.some((hit) => hit.url.includes("extension"))).toBe(true);
  expect(trigger.hits.some((hit) => hit.url.includes("trigger"))).toBe(true);
}, 60_000);

test("an empty query and a query with no matches return an empty list", async () => {
  const missing = await ask("");
  const blank = await ask(undefined);
  const none = await ask("qxqxqxqxqx");
  expect(missing.hits).toEqual([]);
  expect(blank.hits).toEqual([]);
  expect(none.hits).toEqual([]);
  expect(missing.status).toBe(200);
  expect(none.status).toBe(200);
}, 60_000);

/**
 * One search hit the dialog can open.
 */
interface Hit {
  readonly url: string;
  readonly content?: string;
  readonly title?: string;
}

/**
 * Call the route handler.
 *
 * @param query - Search text. Omit it to send no `query` parameter
 */
async function ask(query: string | undefined): Promise<{
  readonly status: number;
  readonly bytes: number;
  readonly hits: readonly Hit[];
}> {
  const url = new URL("http://localhost/api/search");
  if (query !== undefined) url.searchParams.set("query", query);
  const response = await GET(new Request(url));
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a list, got ${text.slice(0, 80)}`);
  }
  return { status: response.status, bytes: Buffer.byteLength(text), hits: parsed as Hit[] };
}

/**
 * A hit has a URL and a title or excerpt.
 *
 * @param hit - One JSON element
 */
function isHit(hit: Hit): boolean {
  const label = hit.content ?? hit.title;
  return typeof hit.url === "string" && hit.url.length > 0 && typeof label === "string" && label.length > 0;
}
