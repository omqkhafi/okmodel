/**
 * Sidebar icons. Lucide, one glyph per public page, attached on the page tree
 * the same way the OKEngine handbook does. The sidebar renders `node.icon`;
 * it does not import the icon package itself.
 */

import type { LoaderPlugin } from "fumadocs-core/source";
import {
  Bookmark,
  Braces,
  Building2,
  Cable,
  CaseSensitive,
  CirclePlus,
  Columns3,
  Eye,
  FileText,
  KeyRound,
  Link2,
  ListFilter,
  ListTree,
  Play,
  Puzzle,
  Rows3,
  Search,
  Shapes,
  ShieldCheck,
  SquareCheck,
  Table2,
  Terminal,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

/** Docs path → Lucide component. `/docs` is the landing and is not a sidebar row. */
const PATH_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/docs/start": Terminal,
  "/docs/start/basic-usage": Play,
  "/docs/define/config": FileText,
  "/docs/define/connect": Cable,
  "/docs/define/schema": Braces,
  "/docs/define/table": Table2,
  "/docs/define/table/keys": KeyRound,
  "/docs/define/table/columns": Columns3,
  "/docs/define/table/defaults": CirclePlus,
  "/docs/define/table/shape": Shapes,
  "/docs/define/table/names": CaseSensitive,
  "/docs/define/table/visibility": Eye,
  "/docs/define/table/validation": ShieldCheck,
  "/docs/define/table/references": Link2,
  "/docs/define/table/relations": Waypoints,
  "/docs/define/table/indexes": ListTree,
  "/docs/define/table/checks": SquareCheck,
  "/docs/define/table/filters": ListFilter,
  "/docs/define/table/traits": Puzzle,
  "/docs/define/table/tenancy": Building2,
  "/docs/define/table/presets": Bookmark,
  "/docs/define/table/reference-rows": Rows3,
  "/docs/define/table/queries": Search,
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
      folder(node) {
        const url = node.index?.url;
        if (typeof url === "string") {
          const Icon = PATH_ICONS[url];
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
