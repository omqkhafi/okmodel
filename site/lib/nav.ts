/**
 * Top-level surface model for the header tab strip.
 *
 * The strip is the only site-wide navigation: three tabs, then theme and npm,
 * then the GitHub link. Anything deeper than a tab belongs in the docs sidebar.
 */

/** One tab in the header strip. */
export interface NavTab {
  /** Stable key. */
  readonly id: string;
  /** Label — stored lowercase, uppercased by CSS. */
  readonly label: string;
  readonly href: string;
  /** Active for nested paths too (`/docs/anything`), not just an exact match. */
  readonly nested?: boolean;
}

/** The three tabs, in strip order. */
export const NAV_TABS: ReadonlyArray<NavTab> = [
  { id: "readme", label: "readme", href: "/" },
  { id: "docs", label: "docs", href: "/docs", nested: true },
  { id: "changelog", label: "changelog", href: "/changelog", nested: true },
];

/**
 * Whether a tab is the current surface.
 *
 * @param tab - Tab descriptor
 * @param pathname - Current pathname
 */
export function isNavTabActive(tab: NavTab, pathname: string): boolean {
  if (tab.nested !== true) return pathname === tab.href;
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

/**
 * Whether the route renders the docs shell — a fixed left pane under the strip.
 *
 * @param pathname - Current pathname
 */
export function hasDocsPane(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

/** Where the header's brand cell ends on a given surface. */
export interface HeaderGeometry {
  /**
   * Brand cell width as a raw CSS value. It is both the rendered width and
   * the value the width animation interpolates from.
   */
  readonly paneWidth: string;
  /** Rule colour, matching the rules already drawn on the page below. */
  readonly rule: string;
}

/**
 * Header geometry for a route class. The brand cell ends where the first
 * vertical rule of the page below begins.
 *
 * @param pathname - Current pathname
 */
export function headerGeometry(pathname: string): HeaderGeometry {
  if (hasDocsPane(pathname)) {
    return {
      paneWidth: "var(--landing-left-pane-width)",
      rule: "border-fd-foreground/5",
    };
  }
  if (pathname === "/changelog" || pathname.startsWith("/changelog/")) {
    return { paneWidth: "30%", rule: "border-fd-border" };
  }
  return { paneWidth: "44%", rule: "border-fd-border" };
}
