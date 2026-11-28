/**
 * Docs page chrome: section order, breadcrumbs, and empty group headings.
 *
 * The sidebar and the page footer both read {@link visibleTree}, so a group
 * with no pages is absent in both places.
 */

import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";
import { findNeighbour } from "fumadocs-core/page-tree";
import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";

import { source } from "./source";

/** One step in the breadcrumb trail. */
export type Crumb = {
  readonly name: string;
  readonly url?: string;
};

/** Previous or next page in sidebar order. */
export type PageNeighbour = {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
};

/** Pages on either side of `url`, in sidebar order. */
export type PageNeighbours = {
  readonly previous?: PageNeighbour;
  readonly next?: PageNeighbour;
};

/**
 * Drop separators that open an empty group, and folders that contain no page.
 *
 * @param tree - Fumadocs page tree
 */
export function omitEmptyGroups(tree: PageTree.Root): PageTree.Root {
  return { ...tree, children: filterNodes(tree.children) };
}

/**
 * Page tree the sidebar and the footer share.
 */
export function visibleTree(): PageTree.Root {
  return omitEmptyGroups(source.getPageTree());
}

/**
 * Breadcrumb from the docs root to the current page.
 *
 * @param url - Handbook path
 */
export function breadcrumbItems(url: string): readonly Crumb[] {
  return getBreadcrumbItems(url, visibleTree(), {
    includePage: true,
    includeRoot: { url: "/docs" },
  }).flatMap((item) => {
    const name = nodeName(item.name);
    if (name.length === 0) return [];
    return [{ name, url: item.url }];
  });
}

/**
 * Previous and next pages in sidebar order.
 *
 * @param url - Handbook path
 */
export function pageNeighbours(url: string): PageNeighbours {
  const found = findNeighbour(visibleTree(), url);
  return {
    previous: neighbour(found.previous),
    next: neighbour(found.next),
  };
}

/**
 * Handbook URLs in sidebar order, empty groups omitted.
 *
 * @param tree - Sidebar tree. Defaults to {@link visibleTree}.
 */
export function orderedHandbookUrls(tree: PageTree.Root = visibleTree()): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  const walk = (nodes: readonly PageTree.Node[]): void => {
    for (const node of nodes) {
      if (node.type === "page") push(node.url);
      else if (node.type === "folder") {
        if (node.index !== undefined) push(node.index.url);
        walk(node.children);
      }
    }
  };
  walk(tree.children);
  return urls;
}

/**
 * Whether a node contains a page.
 *
 * @param node - Page-tree node
 */
function hasPage(node: PageTree.Node): boolean {
  if (node.type === "page") return true;
  if (node.type !== "folder") return false;
  if (node.index !== undefined) return true;
  return node.children.some(hasPage);
}

/**
 * Copy a node list without empty groups.
 *
 * @param nodes - Siblings
 */
function filterNodes(nodes: readonly PageTree.Node[]): PageTree.Node[] {
  const out: PageTree.Node[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.type === "separator") {
      if (nodeName(node.name).length === 0) continue;
      let pages = 0;
      for (let next = index + 1; next < nodes.length; next += 1) {
        const sibling = nodes[next];
        if (sibling === undefined || sibling.type === "separator") break;
        if (hasPage(sibling)) pages += 1;
      }
      if (pages === 0) continue;
      out.push(node);
      continue;
    }
    if (node.type === "folder") {
      const children = filterNodes(node.children);
      if (node.index === undefined && !children.some(hasPage)) continue;
      out.push({ ...node, children });
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * String label of a tree node. Icons and elements are skipped.
 *
 * @param name - Node name
 */
function nodeName(name: ReactNode): string {
  return typeof name === "string" ? name.trim() : "";
}

/**
 * Footer item for one neighbour.
 *
 * @param item - Page-tree item from `findNeighbour`
 */
function neighbour(item: PageTree.Item | undefined): PageNeighbour | undefined {
  if (item === undefined) return undefined;
  const name = nodeName(item.name);
  if (name.length === 0 || item.url.length === 0) return undefined;
  const description = typeof item.description === "string" ? item.description : undefined;
  return { name, url: item.url, description };
}
