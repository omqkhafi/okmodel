/**
 * Docs sidebar. Structure adapted from better-auth/better-auth
 * `docs/components/docs/docs-sidebar.tsx` under the MIT License.
 * Copyright (c) 2024 - present, Bereket Engida. See site/NOTICE.
 *
 * Folders are `<details>` so every page link is in the HTML and works
 * without JavaScript. `meta.json` is the navigation source.
 */

"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSearchContext } from "@fumadocs/base-ui/contexts/search";
import { ThemeSwitch } from "@fumadocs/base-ui/layouts/shared/slots/theme-switch";
import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";
import { GithubMark } from "@/components/chrome/icons";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";

/**
 * Whether a URL is the current page.
 *
 * @param url - Candidate URL
 * @param pathname - Current pathname
 */
function isUrlActive(url: string, pathname: string): boolean {
  return pathname === url;
}

/**
 * Whether a folder contains the current page.
 *
 * @param node - Folder node
 * @param pathname - Current pathname
 */
function containsPathname(node: PageTree.Folder, pathname: string): boolean {
  if (node.index && isUrlActive(node.index.url, pathname)) return true;
  return node.children.some((child) => {
    if (child.type === "page") return isUrlActive(child.url, pathname);
    if (child.type === "folder") return containsPathname(child, pathname);
    return false;
  });
}

/**
 * Page-tree navigation shared by the sidebar and the mobile menu.
 *
 * @param tree - Fumadocs page tree root
 * @param onNavigate - Called after a link click
 */
export function DocsTreeNav({
  tree,
  onNavigate,
}: {
  tree: PageTree.Root;
  onNavigate?: () => void;
}): ReactNode {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-0.5">
      {tree.children.map((node, index) => (
        <TreeNode key={nodeKey(node, index)} node={node} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  pathname,
  onNavigate,
}: {
  node: PageTree.Node;
  pathname: string;
  onNavigate?: () => void;
}): ReactNode {
  if (node.type === "separator") {
    return (
      <p className="px-2 pt-4 pb-1 font-mono text-[10px] tracking-[0.16em] text-fd-muted-foreground uppercase">
        {node.name}
      </p>
    );
  }
  if (node.type === "page") {
    return <PageLink node={node} pathname={pathname} onNavigate={onNavigate} />;
  }
  const open = containsPathname(node, pathname);
  return (
    <details open={open} className="group/folder">
      <summary className="cursor-pointer list-none px-2 py-1.5 text-sm text-fd-muted-foreground marker:content-none hover:text-fd-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span aria-hidden className="text-[10px] opacity-60 group-open/folder:rotate-90">
            ▸
          </span>
          {node.name}
        </span>
      </summary>
      <div className="flex flex-col gap-0.5 ps-3">
        {node.index ? (
          <PageLink node={node.index} pathname={pathname} onNavigate={onNavigate} />
        ) : null}
        {node.children.map((child, index) => (
          <TreeNode
            key={nodeKey(child, index)}
            node={child}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </details>
  );
}

function PageLink({
  node,
  pathname,
  onNavigate,
}: {
  node: PageTree.Item;
  pathname: string;
  onNavigate?: () => void;
}): ReactNode {
  const active = isUrlActive(node.url, pathname);
  return (
    <Link
      href={node.url}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-fd-foreground/5 font-medium text-fd-foreground"
          : "text-fd-muted-foreground hover:bg-fd-foreground/3 hover:text-fd-foreground",
      )}
    >
      {node.name}
    </Link>
  );
}

function nodeKey(node: PageTree.Node, index: number): string {
  if (node.type === "page") return node.url;
  if (node.type === "folder") return node.$id ?? `folder-${String(index)}`;
  return `sep-${String(index)}`;
}

/** Version row. The string is the root package version, inlined at build. */
function VersionRow() {
  const version = process.env.NEXT_PUBLIC_OKMODEL_VERSION ?? "";
  if (version.length === 0) return null;
  return (
    <Link
      href="/changelog"
      className="flex w-full items-center gap-2 border-b border-fd-foreground/5 px-3.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-foreground/3 hover:text-fd-foreground"
    >
      <span className="font-mono text-xs">v{version}</span>
    </Link>
  );
}

/** Search row. Opens the Fumadocs dialog. */
function SearchRow() {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      onClick={() => setOpenSearch(true)}
      className="flex w-full items-center gap-2 border-b border-fd-foreground/5 px-3.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-foreground/3 hover:text-fd-foreground"
    >
      <Search className="size-3.5 shrink-0" aria-hidden />
      <span>Search</span>
      <kbd className="ml-auto rounded border border-fd-foreground/10 px-1.5 py-0.5 font-mono text-[10px]">
        <span className="text-[11px]">&#8984;</span>K
      </kbd>
    </button>
  );
}

/**
 * Docs sidebar: version, search, page tree, repository, theme.
 *
 * @param tree - Fumadocs page tree root
 */
export function DocsSidebar({ tree }: { tree: PageTree.Root }) {
  return (
    <aside className="docs-sidebar">
      <VersionRow />
      <SearchRow />
      <nav aria-label="Documentation" className="docs-sidebar-scroll flex-1 overflow-x-hidden overflow-y-auto px-2.5 py-2">
        <DocsTreeNav tree={tree} />
      </nav>
      <div className="flex items-center gap-1 border-t border-fd-foreground/5 p-2 text-fd-muted-foreground">
        <a
          href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="GitHub repository"
          className="inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-fd-foreground/5 hover:text-fd-foreground"
        >
          <GithubMark className="size-4" />
        </a>
        <ThemeSwitch className="ms-auto border-fd-foreground/10" mode="light-dark" />
      </div>
    </aside>
  );
}
