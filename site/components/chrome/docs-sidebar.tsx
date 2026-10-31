/**
 * Docs sidebar. The tree comes from `meta.json`. Numbered separators mark each
 * group. Small groups are flattened so pages sit under the label; Schema and
 * Operate stay collapsible. `/docs` itself is omitted; the header tab already
 * opens it.
 */

"use client";

import { BranchIcon, ChevronIcon, GithubMark, SearchIcon } from "@/components/chrome/icons";
import { ThemeButton } from "@/components/chrome/theme-button";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";
import { useSearchContext } from "@fumadocs/base-ui/contexts/search";
import type * as PageTree from "fumadocs-core/page-tree";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

/**
 * Section folders whose children belong directly under the numbered label.
 * Schema and Operate stay as collapsible folders.
 */
const FLAT_SECTIONS = new Set([
  "start",
  "Get started",
  "concepts",
  "Concepts",
  "queries",
  "Queries",
  "migrations",
  "Migrations",
  "guides",
  "Guides",
  "reference",
  "Reference",
  "ai",
  "AI Resources",
]);

/**
 * Whether a node is a folder.
 *
 * @param node - Page-tree node
 */
function isFolder(node: PageTree.Node): node is PageTree.Folder {
  return node.type === "folder";
}

/**
 * Whether this folder is a flat section, not a nested topic folder.
 *
 * @param node - Folder node
 */
function isSectionFolder(node: PageTree.Folder): boolean {
  if (typeof node.name === "string" && FLAT_SECTIONS.has(node.name)) return true;
  const id = node.$id ?? "";
  const last = id.split("/").pop() ?? id;
  return FLAT_SECTIONS.has(last);
}

/**
 * Replace a section folder with its pages, in order.
 *
 * @param node - Section folder
 */
function sectionPages(node: PageTree.Folder): PageTree.Node[] {
  const pages: PageTree.Node[] = [];
  if (node.index) pages.push(node.index);
  for (const child of node.children) {
    if (node.index && child.type === "page" && child.url === node.index.url) continue;
    pages.push(child);
  }
  return pages;
}

/**
 * Lift flat sections so the sidebar lists routes under the numbered label.
 *
 * @param tree - Fumadocs page tree
 */
export function flattenSectionFolders(tree: PageTree.Root): PageTree.Root {
  const children: PageTree.Node[] = [];
  for (const node of tree.children) {
    if (isFolder(node) && isSectionFolder(node)) {
      children.push(...sectionPages(node));
    } else {
      children.push(node);
    }
  }
  return { ...tree, children };
}

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
 * Stable key for a folder.
 *
 * @param node - Folder node
 * @param index - Position in the parent
 */
function folderKey(node: PageTree.Folder, index: number): string {
  return node.$id ?? `folder-${String(index)}`;
}

/**
 * One page row.
 *
 * @param href - Page URL
 * @param active - Whether this is the current page
 * @param icon - Optional glyph from the page tree
 * @param depth - 0 at the section, 1 inside a nested folder
 * @param onNavigate - Called after a click
 * @param children - Label
 */
function TreeLink({
  href,
  active,
  icon,
  depth,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  icon?: ReactNode;
  depth: 0 | 1;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "group relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
        depth === 1 && "pl-5 text-[12.5px]",
        active
          ? "bg-fd-foreground/8 font-medium text-fd-foreground"
          : "text-fd-muted-foreground hover:bg-fd-foreground/4 hover:text-fd-foreground",
      )}
    >
      {icon ? (
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center [&>svg]:size-[14px]",
            active ? "text-fd-foreground opacity-100" : "text-fd-muted-foreground/70",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 grow truncate">{children}</span>
    </Link>
  );
}

/**
 * Numbered section label with a hairline.
 *
 * @param name - Separator text, such as `01 Start`
 */
function TreeSeparator({ name }: { name?: ReactNode }) {
  if (!name) return <div className="mx-2 my-2.5 h-px bg-fd-foreground/5" />;
  return (
    <div className="mx-2 mt-4 mb-1.5 flex flex-row items-center gap-2 first:mt-1">
      <p className="font-mono text-[10px] font-medium tracking-[0.16em] text-fd-muted-foreground/75 uppercase select-none">
        {name}
      </p>
      <div className="h-px grow bg-fd-foreground/8" />
    </div>
  );
}

/**
 * Pages inside one open folder.
 *
 * @param node - Folder node
 * @param pathname - Current pathname
 * @param onNavigate - Called after a link click
 */
function GroupBody({
  node,
  pathname,
  onNavigate,
}: {
  node: PageTree.Folder;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="relative my-0.5 ml-3.5 flex flex-col gap-0.5 border-l border-fd-foreground/8 py-0.5 pl-2">
      {node.index ? (
        <TreeLink
          href={node.index.url}
          active={isUrlActive(node.index.url, pathname)}
          icon={node.index.icon}
          depth={1}
          onNavigate={onNavigate}
        >
          {node.index.name}
        </TreeLink>
      ) : null}
      {node.children.map((child, index) => {
        if (child.type === "separator") return <TreeSeparator key={`sep-${String(index)}`} name={child.name} />;
        if (child.type !== "page") return null;
        if (node.index && child.url === node.index.url) return null;
        return (
          <TreeLink
            key={child.url}
            href={child.url}
            active={isUrlActive(child.url, pathname)}
            icon={child.icon}
            depth={1}
            onNavigate={onNavigate}
          >
            {child.name}
          </TreeLink>
        );
      })}
    </div>
  );
}

/**
 * Page-tree navigation shared by the sidebar and the mobile menu.
 *
 * @param tree - Fumadocs page tree root
 * @param onNavigate - Called after a link click
 */
export function DocsTreeNav({
  tree: rawTree,
  onNavigate,
}: {
  tree: PageTree.Root;
  onNavigate?: () => void;
}): ReactNode {
  const pathname = usePathname();
  const tree = useMemo(() => flattenSectionFolders(rawTree), [rawTree]);
  const folders = useMemo(
    () =>
      tree.children.flatMap((node, index) =>
        isFolder(node) ? [{ key: folderKey(node, index), node }] : [],
      ),
    [tree],
  );
  const [override, setOverride] = useState<{ pathname: string; key: string | null } | null>(null);
  const openFromPath = folders.find((entry) => containsPathname(entry.node, pathname))?.key ?? null;
  const openKey = override?.pathname === pathname ? override.key : openFromPath;

  return (
    <div className="flex flex-col gap-0.5">
      {tree.children.map((node, index) => {
        if (node.type === "separator") {
          return <TreeSeparator key={`root-sep-${String(index)}`} name={node.name} />;
        }
        if (node.type === "page") {
          if (node.url === "/docs") return null;
          return (
            <TreeLink
              key={node.url}
              href={node.url}
              active={isUrlActive(node.url, pathname)}
              icon={node.icon}
              depth={0}
              onNavigate={onNavigate}
            >
              {node.name}
            </TreeLink>
          );
        }
        const key = folderKey(node, index);
        const open = openKey === key;
        return (
          <div key={key} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOverride({ pathname, key: open ? null : key })}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                open
                  ? "font-semibold text-fd-foreground"
                  : "text-fd-muted-foreground hover:bg-fd-foreground/4 hover:text-fd-foreground",
              )}
            >
              {node.icon ? (
                <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-[15px]">
                  {node.icon}
                </span>
              ) : null}
              <span className="grow truncate">{node.name}</span>
              <ChevronIcon
                className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")}
              />
            </button>
            {open ? <GroupBody node={node} pathname={pathname} onNavigate={onNavigate} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Version row. The string is the root package version, inlined at build.
 * It stays so the sidebar can name the package version and open the changelog.
 */
function VersionRow() {
  const version = process.env.NEXT_PUBLIC_OKMODEL_VERSION ?? "";
  if (version.length === 0) return null;
  return (
    <Link
      href="/changelog"
      className="group/version flex w-full items-center gap-2 border-b border-fd-foreground/5 px-3.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-foreground/3 hover:text-fd-foreground/80"
    >
      <BranchIcon className="size-3.5 shrink-0 opacity-55" />
      <span className="truncate font-mono text-xs">v{version}</span>
    </Link>
  );
}

/** Search row. Opens the search dialog. */
function SearchRow() {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      onClick={() => setOpenSearch(true)}
      className="group/search flex w-full items-center gap-2 border-b border-fd-foreground/5 px-3.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-foreground/3 hover:text-fd-foreground/80"
    >
      <SearchIcon className="size-3.5 shrink-0 opacity-55" />
      <span className="truncate text-xs">Search</span>
      <kbd className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-fd-foreground/10 px-1.5 py-0.5 font-mono text-[10px] text-fd-muted-foreground">
        <span className="text-[11px]">&#8984;</span>K
      </kbd>
    </button>
  );
}

/**
 * Fixed docs sidebar: version, search, page tree, repository, theme.
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
        <ThemeButton className="ms-auto inline-flex size-8 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-foreground/5 hover:text-fd-foreground" />
      </div>
    </aside>
  );
}
