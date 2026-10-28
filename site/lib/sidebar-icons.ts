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
  Fingerprint,
  GalleryHorizontal,
  Gauge,
  GitPullRequest,
  Hash,
  KeyRound,
  Layers,
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
  TriangleAlert,
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
  "/docs/operate/using-okmodel-safely": Lock,
  "/docs/migrations/from-drizzle": FileInput,
  "/docs/migrations/adopt-existing-database": FolderInput,
  "/docs/reference/config": Settings,
  "/docs/reference/config-database": Database,
  "/docs/reference/config-roles": Users,
  "/docs/operate/connect": Cable,
  "/docs/operate/drivers": Unplug,
  "/docs/operate/target": Crosshair,
  "/docs/operate/replicas-and-topology": Network,
  "/docs/operate/startup-check": BadgeCheck,
  "/docs/operate/session-and-pool": Layers,
  "/docs/operate/session-settings": Settings,
  "/docs/operate/query-limits": Gauge,
  "/docs/operate/errors": CircleAlert,
  "/docs/schema/id-generators": Dices,
  "/docs/operate/observers": Radio,
  "/docs/operate/opentelemetry": Activity,
  "/docs/schema/the-schema": Braces,
  "/docs/schema/the-schema-tables": TableProperties,
  "/docs/schema/casing": CaseUpper,
  "/docs/schema/codecs": Binary,
  "/docs/schema/row-types": Type,
  "/docs/schema/id-default": Fingerprint,
  "/docs/schema/min-postgres": Database,
  "/docs/schema/traits-schema": Boxes,
  "/docs/schema/tenancy-schema": Building,
  "/docs/schema/validation-schema": Shield,
  "/docs/schema/extensions": Blocks,
  "/docs/schema/functions": SquareFunction,
  "/docs/schema/triggers": Zap,
  "/docs/schema/views": GalleryHorizontal,
  "/docs/schema/several-catalogs": Share2,
  "/docs/schema/tables": Table2,
  "/docs/schema/keys-and-identity": KeyRound,
  "/docs/schema/columns": Columns3,
  "/docs/schema/defaults": CirclePlus,
  "/docs/schema/enums-arrays-picklists": Shapes,
  "/docs/schema/names-and-casing": CaseSensitive,
  "/docs/schema/visibility": Eye,
  "/docs/schema/validation": ShieldCheck,
  "/docs/schema/references": Link2,
  "/docs/schema/relations": Waypoints,
  "/docs/schema/indexes": ListTree,
  "/docs/schema/checks": SquareCheck,
  "/docs/queries/request-filters": ListFilter,
  "/docs/schema/traits": Puzzle,
  "/docs/schema/tenancy": Building2,
  "/docs/queries/presets": Bookmark,
  "/docs/schema/required-rows": Rows3,
  "/docs/queries": Search,
  "/docs/reference/cli": SquareTerminal,
  "/docs/reference/schema-api": Braces,
  "/docs/reference/github-action": GitPullRequest,
  "/docs/reference/errors": OctagonAlert,
  "/docs/reference/warnings": TriangleAlert,
  "/docs/migrations/type-change": Replace,
  "/docs/reference/okid": Hash,
  "/docs/reference/environment-variables": Variable,
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
