/**
 * Breadcrumbs, neighbours, and empty group headings.
 */

import { expect, test } from "bun:test";

import { breadcrumbItems, omitEmptyGroups, orderedHandbookUrls, pageNeighbours, visibleTree } from "./page-chrome";
import { source } from "./source";

test("a nested page has a breadcrumb and neighbours in section order", () => {
  const crumbs = breadcrumbItems("/docs/schema/tables");
  expect(crumbs.map((item) => item.name)).toContain("Schema");
  expect(crumbs.at(-1)?.url).toBe("/docs/schema/tables");
  const neighbours = pageNeighbours("/docs/schema/tables");
  expect(neighbours.previous?.url).toBeDefined();
  expect(neighbours.next?.url).toBeDefined();
  const order = orderedHandbookUrls();
  const here = order.indexOf("/docs/schema/tables");
  expect(order[here - 1]).toBe(neighbours.previous?.url);
  expect(order[here + 1]).toBe(neighbours.next?.url);
});

test("an empty group heading is omitted", () => {
  const tree = visibleTree();
  expect(emptySeparator(tree.children)).toBe(false);
  const cleaned = omitEmptyGroups({
    name: "Docs",
    children: [
      { type: "separator", name: "Empty" },
      { type: "separator", name: "Kept" },
      { type: "page", name: "Page", url: "/docs/schema/tables" },
      { type: "separator", name: "" },
    ],
  } as Parameters<typeof omitEmptyGroups>[0]).children;
  expect(cleaned).toHaveLength(2);
  expect(cleaned[0]).toMatchObject({ type: "separator", name: "Kept" });
});

/**
 * True when a separator has no following page.
 *
 * @param nodes - Tree children
 */
function emptySeparator(nodes: readonly { readonly type: string; readonly name?: unknown; readonly children?: readonly { readonly type: string }[] }[]): boolean {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.type === "separator") {
      const next = nodes[index + 1];
      if (next === undefined || next.type === "separator") return true;
    }
    if (node.type === "folder" && node.children !== undefined && emptySeparator(node.children)) return true;
  }
  return false;
}

test("the schema tree still has its group headings", () => {
  const schema = source.getPageTree().children.find((node) => node.type === "folder" && node.name === "Schema");
  expect(schema).toBeDefined();
  if (schema?.type !== "folder") return;
  const names = schema.children.flatMap((node) => (node.type === "separator" && typeof node.name === "string" ? [node.name] : []));
  expect(names).toEqual([
    "Tables and columns",
    "Types",
    "Keys and constraints",
    "Security",
    "Code in the database",
    "Packs",
    "Physical layout",
  ]);
});
