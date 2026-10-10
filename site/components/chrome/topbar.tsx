/**
 * Header tab strip. Structure adapted from better-auth/better-auth
 * `docs/components/landing/staggered-nav-files.tsx` under the MIT License.
 * Copyright (c) 2024 - present, Bereket Engida. See site/NOTICE.
 *
 * The bar is one row, `--landing-topbar-height` tall, split into a brand cell and
 * an equal-width tab strip. It is fixed to the viewport and mounted once in the
 * root layout. The brand cell's width is a CSS length, so it transitions without
 * a motion library. `prefers-reduced-motion` drops that transition.
 */

"use client";

import { CloseIcon, ExternalArrow, GithubMark, MenuIcon, NpmMark, SearchIcon } from "@/components/chrome/icons";
import { DocsTreeNav } from "@/components/chrome/docs-sidebar";
import { ThemeButton } from "@/components/chrome/theme-button";
import { Wordmark } from "@/components/wordmark";
import { cn } from "@/lib/cn";
import { hasDocsPane, headerGeometry, isNavTabActive, NAV_TABS } from "@/lib/nav";
import { SITE_NAME } from "@/lib/site-identity";
import { githubRepoUrl } from "@/lib/shared";
import { useSearchContext } from "@fumadocs/base-ui/contexts/search";
import type * as PageTree from "fumadocs-core/page-tree";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const REPO_URL = githubRepoUrl;

/** Flush 1:1 header cells — height is `--landing-topbar-height`. */
const SQUARE_CELL = "flex aspect-square h-full shrink-0 items-center justify-center";

/**
 * Fixed site header. Mount once, in the root layout.
 *
 * @param tree - Docs page tree, for the mobile overlay's docs navigation
 */
export function Topbar({ tree }: { tree: PageTree.Root }) {
  const pathname = usePathname();
  const { setOpenSearch } = useSearchContext();
  const isDocs = hasDocsPane(pathname);
  const { paneWidth, rule } = headerGeometry(pathname);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const menuOpen = openedAt === pathname;
  const closeMenu = () => setOpenedAt(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenedAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-[99] bg-fd-background">
        <div className={cn("relative flex h-(--landing-topbar-height) items-stretch border-b", rule)}>
          <div
            style={{ width: paneWidth }}
            className={cn(
              "topbar-width relative hidden shrink-0 items-stretch border-e transition-[width] duration-300 ease-out motion-reduce:transition-none lg:flex",
              rule,
            )}
          >
            <Link
              href="/"
              className="flex h-full items-center px-4 text-fd-foreground transition-opacity hover:opacity-80"
            >
              <Wordmark />
            </Link>
          </div>

          <div className="flex w-full items-center gap-1 px-3 lg:hidden">
            <Link href="/" className="mr-auto flex items-center text-fd-foreground">
              <Wordmark />
            </Link>
            <button
              type="button"
              aria-label="Search"
              onClick={() => setOpenSearch(true)}
              className="inline-flex size-8 items-center justify-center text-fd-muted-foreground transition-colors hover:text-fd-foreground"
            >
              <SearchIcon className="size-4" />
            </button>
            <ThemeButton className="inline-flex size-8 items-center justify-center text-fd-muted-foreground" />
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setOpenedAt(menuOpen ? null : pathname)}
              className="inline-flex size-8 items-center justify-center text-fd-muted-foreground transition-colors hover:text-fd-foreground"
            >
              {menuOpen ? <CloseIcon className="size-4" /> : <MenuIcon className="size-4" />}
            </button>
          </div>

          <div className="relative hidden min-w-0 flex-1 items-stretch lg:flex">
            {NAV_TABS.map((tab) => {
              const active = isNavTabActive(tab, pathname);
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group/tab relative flex flex-1 items-center justify-center border-e px-2 transition-colors duration-150 xl:px-4",
                    rule,
                    active ? undefined : "hover:bg-fd-foreground/[0.03]",
                  )}
                >
                  <span
                    className={cn(
                      "font-mono text-xs tracking-wider whitespace-nowrap uppercase transition-colors duration-150",
                      active
                        ? "text-fd-foreground"
                        : "text-fd-muted-foreground group-hover/tab:text-fd-foreground/75",
                    )}
                  >
                    {tab.label}
                  </span>
                  {active ? (
                    <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-fd-foreground/50" />
                  ) : null}
                </Link>
              );
            })}

            <ThemeButton
              className={cn(
                SQUARE_CELL,
                "text-fd-muted-foreground transition-colors duration-150 hover:bg-fd-foreground/[0.03] hover:text-fd-foreground",
              )}
            />
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex shrink-0 cursor-pointer items-center gap-1.5 bg-fd-foreground px-5 text-fd-background transition-opacity duration-150 hover:opacity-90"
            >
              <GithubMark className="size-3.5 opacity-70" />
              <span className="font-mono text-xs tracking-wider uppercase">github</span>
              <ExternalArrow className="size-2.5 opacity-50" />
            </a>
            <NpmLink className={cn(SQUARE_CELL, "transition-opacity duration-150 hover:opacity-90")} />
          </div>
        </div>

        {menuOpen ? (
          <div className="fixed inset-x-0 top-(--landing-topbar-height) bottom-0 z-[98] overflow-y-auto bg-fd-background lg:hidden">
            <nav className="flex flex-col border-b border-fd-border">
              {NAV_TABS.map((tab) => (
                <Link
                  key={tab.id}
                  href={tab.href}
                  onClick={closeMenu}
                  className={cn(
                    "border-b border-fd-border px-4 py-3 font-mono text-xs tracking-wider uppercase transition-colors",
                    isNavTabActive(tab, pathname)
                      ? "bg-fd-foreground/5 text-fd-foreground"
                      : "text-fd-muted-foreground hover:text-fd-foreground",
                  )}
                >
                  {tab.label}
                </Link>
              ))}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-2 px-4 py-3 font-mono text-xs tracking-wider text-fd-muted-foreground uppercase transition-colors hover:text-fd-foreground"
              >
                <GithubMark className="size-3.5" />
                github
                <ExternalArrow className="size-2.5 opacity-50" />
              </a>
              <NpmMenuLink />
            </nav>
            {isDocs ? (
              <div className="pb-16">
                <DocsTreeNav tree={tree} onNavigate={closeMenu} />
              </div>
            ) : null}
          </div>
        ) : null}
      </header>
      <div aria-hidden className="h-(--landing-topbar-height) shrink-0" />
    </>
  );
}

/** npm page. The URL is the package name, inlined at build. */
function NpmLink({ className }: { className?: string }) {
  const href = process.env.NEXT_PUBLIC_NPM_URL;
  if (href === undefined || href.length === 0) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${SITE_NAME} on npm`}
      className={className}
    >
      <NpmMark className="block size-full shrink-0" />
    </a>
  );
}

/** npm row in the mobile menu. */
function NpmMenuLink() {
  const href = process.env.NEXT_PUBLIC_NPM_URL;
  if (href === undefined || href.length === 0) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2 px-4 py-3 font-mono text-xs tracking-wider text-fd-muted-foreground uppercase transition-colors hover:text-fd-foreground"
    >
      <NpmMark className="size-3.5 shrink-0" />
      npm
      <ExternalArrow className="size-2.5 opacity-50" />
    </a>
  );
}
