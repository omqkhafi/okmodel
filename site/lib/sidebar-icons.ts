/**
 * Sidebar icons. Lucide, one glyph per public page, attached on the page tree
 * the same way the OKEngine handbook does. The sidebar renders `node.icon`;
 * it does not import the icon package itself.
 */

import type { LoaderPlugin } from "fumadocs-core/source";
import {
  Asterisk,
  Binary,
  Bookmark,
  Braces,
  CaseSensitive,
  Clock,
  Columns3,
  Database,
  Eye,
  EyeOff,
  FileText,
  Folder,
  GitFork,
  Hash,
  Key,
  KeyRound,
  Layers,
  Link2,
  List,
  ListChecks,
  Play,
  Puzzle,
  Rows3,
  Server,
  Shapes,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  SquareCheck,
  SquareFunction,
  Table2,
  Tag,
  Terminal,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

/** Docs path → Lucide component. `/docs` is the landing and is not a sidebar row. */
const PATH_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/docs/start/query": Terminal,
  "/docs/start/basic-usage": Play,
  "/docs/config/file": FileText,
  "/docs/config/targets": Database,
  "/docs/config/paths": Folder,
  "/docs/config/pooler": Waypoints,
  "/docs/config/timeouts": Clock,
  "/docs/config/lint": ListChecks,
  "/docs/config/backfill": Rows3,
  "/docs/config/roles": Shield,
  "/docs/schema/tables": Table2,
  "/docs/schema/casing": CaseSensitive,
  "/docs/schema/codecs": Binary,
  "/docs/schema/types": Braces,
  "/docs/schema/defaults": Hash,
  "/docs/schema/requires": Server,
  "/docs/schema/traits": Layers,
  "/docs/schema/tenancy": KeyRound,
  "/docs/schema/validation": ShieldCheck,
  "/docs/schema/extensions": Puzzle,
  "/docs/schema/functions": SquareFunction,
  "/docs/schema/triggers": Zap,
  "/docs/schema/views": Eye,
  "/docs/table/columns": Columns3,
  "/docs/table/keys": Key,
  "/docs/table/indexes": List,
  "/docs/table/checks": SquareCheck,
  "/docs/table/defaults": Asterisk,
  "/docs/table/references": Link2,
  "/docs/table/relations": GitFork,
  "/docs/table/visibility": EyeOff,
  "/docs/table/names": Tag,
  "/docs/table/traits": Layers,
  "/docs/table/tenancy": KeyRound,
  "/docs/table/presets": Bookmark,
  "/docs/table/reference": Database,
  "/docs/table/filters": SlidersHorizontal,
  "/docs/table/validation": ShieldCheck,
  "/docs/table/shape": Shapes,
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
