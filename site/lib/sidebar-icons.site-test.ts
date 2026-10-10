/**
 * Sidebar routes stay flat under the numbered labels, and every page has an icon.
 */

import { expect, test } from "bun:test";
import type * as PageTree from "fumadocs-core/page-tree";

import { flattenSectionFolders } from "../components/chrome/docs-sidebar";
import { mappedPages, pageHref } from "./docs-map";
import { hasSidebarIcon } from "./sidebar-icons";

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
        children: [
          { type: "page", name: "Install", url: "/docs/start/install" },
          { type: "page", name: "First query", url: "/docs/start/query" },
        ],
      },
      { type: "separator", name: "04 Reference" },
      {
        type: "folder",
        name: "Reference",
        $id: "reference",
        children: [{ type: "page", name: "Production", url: "/docs/reference/production" }],
      },
    ],
  } as PageTree.Root;

  const flat = flattenSectionFolders(tree);
  expect(flat.children.map((node) => (node.type === "page" ? node.url : node.type === "separator" ? node.name : node.type))).toEqual([
    "/docs",
    "01 Start",
    "/docs/start/install",
    "/docs/start/query",
    "04 Reference",
    "/docs/reference/production",
  ]);
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = mappedPages
    .map((page) => pageHref(page))
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
