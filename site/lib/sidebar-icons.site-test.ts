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
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
