/**
 * Sidebar groups are the capability folders, and every page has an icon.
 */

import { expect, test } from "bun:test";

import { hasSidebarIcon } from "./sidebar-icons";
import { source } from "./source";

test("pages sit flat under the capability groups", () => {
  const folders = source.getPageTree().children.flatMap((node) => (node.type === "folder" ? [node] : []));
  expect(folders.map((folder) => folder.name)).toEqual([
    "Get started",
    "Schema",
    "Queries",
    "Migrations",
    "Operate",
    "Reference",
    "AI Resources",
  ]);
  for (const folder of folders) {
    expect(folder.children.every((child) => child.type === "page")).toBe(true);
  }
  const urls = folders.flatMap((folder) => folder.children.flatMap((child) => (child.type === "page" ? [child.url] : [])));
  expect(urls).toContain("/docs/reference/cli");
  expect(urls).toContain("/docs/reference/errors");
  expect(urls).toContain("/docs/migrations/from-drizzle");
  expect(urls).toContain("/docs/ai/skills");
  expect(urls).toContain("/docs/ai/llm");
  expect(urls).not.toContain("/docs/ai/mcp");
  const byFolder = new Map(folders.map((folder) => [folder.name, folder]));
  const operate = byFolder.get("Operate");
  const migrations = byFolder.get("Migrations");
  const queries = byFolder.get("Queries");
  if (operate === undefined || migrations === undefined || queries === undefined) throw new Error("missing group");
  const childUrls = (folder: (typeof folders)[number]): string[] =>
    folder.children.flatMap((child) => (child.type === "page" ? [child.url] : []));
  expect(childUrls(operate)).toEqual([
    "/docs/operate/using-okmodel-safely",
    "/docs/operate/production-checklist",
    "/docs/operate/testing",
    "/docs/operate/protected-targets-and-roles",
    "/docs/operate/connect",
    "/docs/operate/target",
    "/docs/operate/drivers",
    "/docs/operate/session-and-pool",
    "/docs/operate/query-limits",
    "/docs/operate/startup-check",
    "/docs/operate/replicas-and-topology",
    "/docs/operate/session-settings",
    "/docs/operate/observers",
    "/docs/operate/opentelemetry",
    "/docs/operate/errors",
  ]);
  expect(queries.index?.url).toBe("/docs/queries");
  expect(childUrls(queries)).toEqual([
    "/docs/queries/read-rows",
    "/docs/queries/write-rows",
    "/docs/queries/shape-results",
    "/docs/queries/search-and-trees",
    "/docs/queries/typed-raw-sql",
    "/docs/queries/presets",
    "/docs/queries/request-filters",
  ]);
  expect(childUrls(migrations)).toEqual([
    "/docs/migrations/adopt-existing-database",
    "/docs/migrations/from-drizzle",
    "/docs/migrations/checks-and-lint",
    "/docs/migrations/backfill",
    "/docs/migrations/type-change",
    "/docs/migrations/failures",
    "/docs/migrations/environments",
  ]);
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
