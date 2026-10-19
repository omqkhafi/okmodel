/**
 * Sidebar icons. Lucide, one glyph per public page, attached on the page tree
 * the same way the OKEngine handbook does. The sidebar renders `node.icon`;
 * it does not import the icon package itself.
 */

import type { LoaderPlugin } from "fumadocs-core/source";
import {
  Activity,
  BadgeCheck,
  Binary,
  Blocks,
  Bookmark,
  Bot,
  Boxes,
  Braces,
  Building,
  Building2,
  Cable,
  CaseSensitive,
  CaseUpper,
  CircleAlert,
  CirclePlus,
  Columns3,
  Crosshair,
  Database,
  Dices,
  Eye,
  FileCode,
  FileInput,
  FolderInput,
  FolderTree,
  FileText,
  Fingerprint,
  GalleryHorizontal,
  GitPullRequest,
  Hash,
  Import,
  KeyRound,
  Layers,
  Library,
  Link2,
  ListFilter,
  ListTree,
  Lock,
  Network,
  OctagonAlert,
  Play,
  Puzzle,
  Radio,
  Replace,
  Rows3,
  Search,
  Settings,
  Shapes,
  Share2,
  Shield,
  ShieldCheck,
  Sparkles,
  SquareCheck,
  SquareFunction,
  SquareTerminal,
  Table2,
  TableProperties,
  Terminal,
  Timer,
  Type,
  Unplug,
  Users,
  Variable,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

/** Docs path → Lucide component. `/docs` is the landing and is not a sidebar row. */
const PATH_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/docs/start": Terminal,
  "/docs/start/basic-usage": Play,
  "/docs/start/from-drizzle": FileInput,
  "/docs/start/from-existing": FolderInput,
  "/docs/start/safely": Lock,
  "/docs/define/config": Settings,
  "/docs/define/config/schema": Braces,
  "/docs/define/config/database": Database,
  "/docs/define/config/tables": TableProperties,
  "/docs/define/config/migrations": FileText,
  "/docs/define/config/out": Library,
  "/docs/define/config/timeouts": Timer,
  "/docs/define/config/pooler": Layers,
  "/docs/define/config/lint-from": ShieldCheck,
  "/docs/define/config/backfill": Rows3,
  "/docs/define/config/roles": Users,
  "/docs/define/config/namespace": FolderTree,
  "/docs/define/config/external": Import,
  "/docs/define/connect": Cable,
  "/docs/define/connect/drivers": Unplug,
  "/docs/define/connect/target": Crosshair,
  "/docs/define/connect/topology": Network,
  "/docs/define/connect/check": BadgeCheck,
  "/docs/define/connect/session": Layers,
  "/docs/define/connect/errors": CircleAlert,
  "/docs/define/connect/generators": Dices,
  "/docs/define/connect/observers": Radio,
  "/docs/define/connect/otel": Activity,
  "/docs/define/schema": Braces,
  "/docs/define/schema/tables": TableProperties,
  "/docs/define/schema/casing": CaseUpper,
  "/docs/define/schema/codecs": Binary,
  "/docs/define/schema/types": Type,
  "/docs/define/schema/defaults": Fingerprint,
  "/docs/define/schema/min-postgres": Database,
  "/docs/define/schema/traits": Boxes,
  "/docs/define/schema/tenancy": Building,
  "/docs/define/schema/validation": Shield,
  "/docs/define/schema/extensions": Blocks,
  "/docs/define/schema/functions": SquareFunction,
  "/docs/define/schema/triggers": Zap,
  "/docs/define/schema/views": GalleryHorizontal,
  "/docs/define/schema/catalogs": Share2,
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
  "/docs/reference/cli": SquareTerminal,
  "/docs/reference/schema-api": Braces,
  "/docs/reference/github-action": GitPullRequest,
  "/docs/reference/errors": OctagonAlert,
  "/docs/reference/type-change": Replace,
  "/docs/reference/okid": Hash,
  "/docs/reference/environment-variables": Variable,
  "/docs/ai/mcp": Bot,
  "/docs/ai/skills": Sparkles,
  "/docs/ai/llm": FileCode,
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
