/**
 * Sidebar routes stay flat under the numbered labels for small groups.
 * Schema, Operate, and Reference stay collapsible. Every page has an icon.
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
      { type: "separator", name: "1. Get started" },
      {
        type: "folder",
        name: "Get started",
        $id: "start",
        children: [{ type: "page", name: "Introduction", url: "/docs/start" }],
      },
      { type: "separator", name: "3. Schema" },
      {
        type: "folder",
        name: "Schema",
        $id: "schema",
        children: [{ type: "page", name: "Tables", url: "/docs/schema/tables" }],
      },
    ],
  } as PageTree.Root;

  const flat = flattenSectionFolders(tree);
  expect(
    flat.children.map((node) => {
      if (node.type === "page") return node.url;
      if (node.type === "separator") return node.name;
      return node.name;
    }),
  ).toEqual(["/docs", "1. Get started", "/docs/start", "3. Schema", "Schema"]);
});

test("small groups flatten; Schema, Operate, and Reference stay folders", () => {
  const raw = source.getPageTree();
  const flat = flattenSectionFolders(raw);
  const folders = flat.children.flatMap((node) =>
    node.type === "folder" && typeof node.name === "string" ? [node.name] : [],
  );
  expect(folders.sort()).toEqual(["Operate", "Reference", "Schema"]);

  const kept = new Set(folders);
  const rawFolders = raw.children.flatMap((node) =>
    node.type === "folder" && typeof node.name === "string" ? [node.name] : [],
  );
  const labels = flat.children.map((node) =>
    node.type === "page" ? node.url : typeof node.name === "string" ? node.name : node.type,
  );
  for (const name of rawFolders) {
    if (!kept.has(name)) expect(labels, name).not.toContain(name);
  }

  const byName = new Map(
    flat.children.flatMap((node) =>
      node.type === "folder" && typeof node.name === "string" ? [[node.name, node]] : [],
    ),
  );
  const childUrls = (folder: PageTree.Folder): string[] =>
    folder.children.flatMap((child) => {
      if (child.type === "page") return [child.url];
      if (child.type === "folder") {
        const nested = child.children.flatMap((inner) => (inner.type === "page" ? [inner.url] : []));
        return child.index ? [child.index.url, ...nested] : nested;
      }
      return [];
    });
  for (const [name, prefix] of [
    ["Schema", "/docs/schema/"],
    ["Operate", "/docs/operate/"],
    ["Reference", "/docs/reference/"],
  ] as const) {
    const folder = byName.get(name);
    if (folder === undefined) throw new Error(`missing collapsible group ${name}`);
    const urls = childUrls(folder);
    expect(urls.length, name).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(prefix), url).toBe(true);
  }
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
