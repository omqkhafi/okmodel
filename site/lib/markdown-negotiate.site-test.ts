/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";

test("a docs path negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/start")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/define/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/define/config/schema")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/define/config/database")).toBe("/llms.mdx/docs/define/config/database.md");
  expect(markdownTwinPath("/docs/define/config/roles")).toBe("/llms.mdx/docs/define/config/roles.md");
  expect(markdownTwinPath("/docs/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/file")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/targets")).toBe("/llms.mdx/docs/define/config/database.md");
  expect(markdownTwinPath("/docs/config/paths")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/pooler")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/timeouts")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/lint")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/backfill")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/roles")).toBe("/llms.mdx/docs/define/config/roles.md");
  expect(markdownTwinPath("/docs/schema/tables")).toBe("/llms.mdx/docs/define/schema/tables.md");
  expect(markdownTwinPath("/docs/table/columns")).toBe("/llms.mdx/docs/define/table/columns.md");
  expect(markdownTwinPath("/docs/table/reference")).toBe("/llms.mdx/docs/define/table/reference-rows.md");
  expect(markdownTwinPath("/docs/start/query")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs/start/install")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs/model/queries")).toBe("/llms.mdx/docs/define/table/queries.md");
  expect(markdownTwinPath("/docs/start/queries")).toBe("/llms.mdx/docs/define/table/queries.md");
  expect(markdownTwinPath("/docs/model/schema")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/model/safety")).toBe("/llms.mdx/docs/define/table/visibility.md");
  expect(markdownTwinPath("/docs/ship/migrations")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/ship/drivers")).toBe("/llms.mdx/docs/define/connect/drivers.md");
  expect(markdownTwinPath("/docs/define/connect")).toBe("/llms.mdx/docs/define/connect.md");
  expect(markdownTwinPath("/docs/define/connect/session")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/drivers")).toBe("/llms.mdx/docs/define/connect/drivers.md");
  expect(markdownTwinPath("/docs/define/connect/close")).toBe("/llms.mdx/docs/define/connect.md");
  expect(markdownTwinPath("/docs/define/connect/pool")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/prepared")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/tls")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/search-path")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/timeouts")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/define/connect/require-meta")).toBe("/llms.mdx/docs/define/connect/check.md");
  expect(markdownTwinPath("/docs/define/connect/catalog")).toBe("/llms.mdx/docs/define/connect/check.md");
  expect(markdownTwinPath("/docs/known-limits")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/known-limits")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/linter")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/cli")).toBe("/llms.mdx/docs/reference/cli.md");
  expect(markdownTwinPath("/docs/ai/skills")).toBe("/llms.mdx/docs/ai/skills.md");
  expect(markdownTwinPath("/")).toBe("/llms.mdx/home");
  expect(markdownTwinPath("/changelog")).toBe("/llms.mdx/releases");

  const request = new Request("https://okm.omqkhafi.dev/docs/start", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({
    kind: "rewrite",
    pathname: "/llms.mdx/docs/start.md",
  });
});

test("html and machine routes are not rewritten", () => {
  const html = new Request("https://okm.omqkhafi.dev/docs/start", {
    headers: { accept: "text/html" },
  });
  expect(markdownNegotiation(html)).toEqual({ kind: "pass" });

  const sitemap = new Request("https://okm.omqkhafi.dev/sitemap.xml", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(sitemap)).toEqual({ kind: "pass" });
});
