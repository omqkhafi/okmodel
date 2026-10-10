/**
 * Sidebar icons. Lucide, one glyph per public page, attached on the page tree
 * the same way the OKEngine handbook does. The sidebar renders `node.icon`;
 * it does not import the icon package itself.
 */

import type { LoaderPlugin } from "fumadocs-core/source";
import {
  AppWindow,
  BookOpen,
  Braces,
  Cable,
  CircleAlert,
  Database,
  Download,
  FlaskConical,
  GitBranch,
  Layers,
  ListChecks,
  Network,
  Ruler,
  ScanSearch,
  Server,
  Shield,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

/** Docs path → Lucide component. `/docs` is the landing and is not a sidebar row. */
const PATH_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/docs/start/install": Download,
  "/docs/start/query": Terminal,
  "/docs/model/schema": Table2,
  "/docs/model/queries": Braces,
  "/docs/model/safety": Shield,
  "/docs/ship/migrations": GitBranch,
  "/docs/ship/drivers": Cable,
  "/docs/reference/production": ShieldCheck,
  "/docs/reference/environments": Layers,
  "/docs/reference/testing": FlaskConical,
  "/docs/reference/topology": Network,
  "/docs/reference/provisioning": Server,
  "/docs/reference/check": ListChecks,
  "/docs/reference/backfill": Database,
  "/docs/reference/linter": ScanSearch,
  "/docs/reference/compatibility": Cable,
  "/docs/reference/size": Ruler,
  "/docs/reference/known-limits": CircleAlert,
  "/docs/reference/api": Braces,
  "/docs/reference/specification": BookOpen,
  "/docs/reference/editor-check": SquareTerminal,
  "/docs/reference/example-app": AppWindow,
};

/**
 * Whether a public docs path has a sidebar icon.
 *
 * @param path - Absolute docs URL
 */
export function hasSidebarIcon(path: string): boolean {
  return Object.hasOwn(PATH_ICONS, path);
}

/**
 * Loader plugin that stamps a Lucide icon onto each page in the tree.
 */
export function sidebarIconsPlugin(): LoaderPlugin {
  return {
    name: "okm:sidebar-icons",
    transformPageTree: {
      file(node) {
        if (node.url) {
          const Icon = PATH_ICONS[node.url];
          if (Icon) node.icon = iconNode(Icon);
        }
        return node;
      },
    },
  };
}

/**
 * One sidebar glyph. The class matches the 14px slot in the row.
 *
 * @param Icon - Lucide component
 */
function iconNode(Icon: LucideIcon): ReactNode {
  return createElement(Icon, { className: "size-4", "aria-hidden": true });
}
