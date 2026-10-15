/**
 * Sidebar routes stay flat under the numbered labels, and every page has an icon.
 */

import { expect, test } from "bun:test";
import type * as PageTree from "fumadocs-core/page-tree";

import { flattenSectionFolders } from "../components/chrome/docs-sidebar";
import { hasSidebarIcon } from "./sidebar-icons";
import { source } from "./source";

test("section folders become the routes under their label", () => {
  const tree = {
    name: "Docs",
    children: [
      { type: "page", name: "Documentation", url: "/docs" },
      { type: "separator", name: "01 Start" },
      {
        type: "folder",
        name: "Start",
        $id: "start",
        children: [{ type: "page", name: "Let's start", url: "/docs/start" }],
      },
    ],
  } as PageTree.Root;

  const flat = flattenSectionFolders(tree);
  expect(flat.children.map((node) => (node.type === "page" ? node.url : node.type === "separator" ? node.name : node.type))).toEqual([
    "/docs",
    "01 Start",
    "/docs/start",
  ]);
});

test("reference and ai resources sit under their labels", () => {
  const flat = flattenSectionFolders(source.getPageTree());
  const labels = flat.children.map((node) =>
    node.type === "page" ? node.url : node.type === "separator" ? node.name : node.type === "folder" ? node.name : node.type,
  );
  expect(labels).toContain("03 Reference");
  expect(labels).toContain("/docs/reference/cli");
  expect(labels).toContain("/docs/reference/errors");
  expect(labels).toContain("/docs/reference/okid");
  expect(labels).toContain("/docs/reference/environment-variables");
  expect(labels).toContain("04 AI Resources");
  expect(labels).toContain("/docs/ai/mcp");
  expect(labels).toContain("/docs/ai/skills");
  expect(labels).toContain("/docs/ai/llm");
  expect(labels).not.toContain("Reference");
  expect(labels).not.toContain("AI Resources");
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
