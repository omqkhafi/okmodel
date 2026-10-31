/**
 * Sidebar routes stay flat under the numbered labels for small groups.
 * Schema and Operate stay collapsible. Every page has an icon.
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

test("small groups flatten; Schema and Operate stay folders", () => {
  const raw = source.getPageTree();
  const folders = raw.children.flatMap((node) => (node.type === "folder" ? [node] : []));
  expect(folders.map((folder) => folder.name)).toEqual([
    "Get started",
    "Concepts",
    "Frameworks",
    "Schema",
    "Queries",
    "Migrations",
    "Operate",
    "Guides",
    "Reference",
    "AI Resources",
  ]);

  const separators = raw.children.flatMap((node) =>
    node.type === "separator" && typeof node.name === "string" ? [node.name] : [],
  );
  expect(separators).toEqual([
    "1. Get started",
    "2. Concepts",
    "3. Frameworks",
    "4. Schema",
    "5. Queries",
    "6. Migrations",
    "7. Operate",
    "8. Guides",
    "9. Reference",
    "10. AI Resources",
  ]);

  const flat = flattenSectionFolders(raw);
  const labels = flat.children.map((node) =>
    node.type === "page" ? node.url : typeof node.name === "string" ? node.name : node.type,
  );
  expect(labels).toContain("1. Get started");
  expect(labels).toContain("/docs/start");
  expect(labels).toContain("/docs/start/first-schema");
  expect(labels).toContain("/docs/concepts/how-okmodel-works");
  expect(labels).toContain("/docs/frameworks/nextjs");
  expect(labels).not.toContain("Frameworks");
  expect(labels).toContain("/docs/queries/read-rows");
  expect(labels).toContain("/docs/migrations/from-drizzle");
  expect(labels).toContain("/docs/guides/soft-delete");
  expect(labels).toContain("/docs/reference/cli");
  expect(labels).toContain("/docs/ai/skills");
  expect(labels).toContain("/docs/ai/llm");
  expect(labels).not.toContain("Get started");
  expect(labels).not.toContain("Concepts");
  expect(labels).not.toContain("Queries");
  expect(labels).not.toContain("Migrations");
  expect(labels).not.toContain("Guides");
  expect(labels).not.toContain("Reference");
  expect(labels).not.toContain("AI Resources");
  expect(labels).toContain("Schema");
  expect(labels).toContain("Operate");
  expect(labels).not.toContain("/docs/ai/mcp");

  const byName = new Map(
    flat.children.flatMap((node) => (node.type === "folder" && typeof node.name === "string" ? [[node.name, node]] : [])),
  );
  const schema = byName.get("Schema");
  const operate = byName.get("Operate");
  if (schema === undefined || operate === undefined) throw new Error("missing collapsible group");
  const childUrls = (folder: PageTree.Folder): string[] =>
    folder.children.flatMap((child) => (child.type === "page" ? [child.url] : []));
  expect(childUrls(schema)).toContain("/docs/schema/tables");
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
    "/docs/operate/observability",
    "/docs/operate/errors",
  ]);
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
