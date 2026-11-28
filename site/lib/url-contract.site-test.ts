/**
 * Every docs URL shipped in README.md, src/, and docs/ resolves.
 */

import { expect, test } from "bun:test";

import { collectShippedDocsUrls, docsUrlResolves } from "./url-contract";

test("shipped docs URLs resolve to a page or an anchor", () => {
  const hits = collectShippedDocsUrls();
  expect(hits.length).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const hit of hits) {
    if (!docsUrlResolves(hit.href)) failures.push(`${hit.file}: ${hit.href}`);
  }
  expect(failures).toEqual([]);
  expect(docsUrlResolves("/docs/schema/keys-and-identity#keys")).toBe(true);
  expect(docsUrlResolves("/docs/schema/extensions#pgvector")).toBe(true);
  expect(docsUrlResolves("/docs/schema/extensions#trigram")).toBe(true);
  expect(docsUrlResolves("/docs/schema/defaults#generated")).toBe(true);
});
