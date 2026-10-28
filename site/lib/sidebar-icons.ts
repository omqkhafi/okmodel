/**
 * Sidebar icons. Lucide, one glyph per public page, attached on the page tree
 * the same way the OKEngine handbook does. The sidebar renders `node.icon`;
 * it does not import the icon package itself.
 */

import type { LoaderPlugin } from "fumadocs-core/source";
import {
  Activity,
  ALargeSmall,
  BadgeCheck,
  Binary,
  Blocks,
  BookOpen,
  Bookmark,
  Boxes,
  Braces,
  Building2,
  Cable,
  Calculator,
  CaseSensitive,
  ChartColumn,
  CircleAlert,
  CirclePlus,
  CircleX,
  ClipboardCheck,
  Clock,
  Columns3,
  Crosshair,
  Database,
  DatabaseZap,
  Eye,
  FileCode,
  FileInput,
  FolderInput,
  FlaskConical,
  GalleryHorizontal,
  Gauge,
  GitCompare,
  GitPullRequest,
  Hash,
  KeyRound,
  Landmark,
  Layers,
  Library,
  Lightbulb,
  Link2,
  ListChecks,
  ListFilter,
  ListTree,
  Lock,
  Network,
  OctagonAlert,
  PenLine,
  Play,
  Puzzle,
  Radio,
  Repeat,
  Replace,
  Rows3,
  Scale,
  ScrollText,
  Search,
  Server,
  Settings,
  Shapes,
  Share2,
  Shield,
  ShieldCheck,
  ShieldPlus,
  Sparkles,
  SquareCheck,
  SquareCode,
  SquareFunction,
  SquareTerminal,
  Table2,
  Terminal,
  TextSearch,
  TriangleAlert,
  Type,
  Unplug,
  Users,
  Variable,
  Waypoints,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

/** Docs path → Lucide component. `/docs` is the landing and is not a sidebar row. */
const PATH_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/docs/start": Terminal,
  "/docs/start/why-okmodel": Lightbulb,
  "/docs/start/installation": Cable,
  "/docs/start/first-schema": Play,
  "/docs/start/project-structure": ListTree,
  "/docs/start/first-migration": ScrollText,
  "/docs/concepts/how-okmodel-works": Workflow,
  "/docs/concepts/the-schema-is-the-catalog": Library,
  "/docs/concepts/type-safety-and-inference": Type,
  "/docs/concepts/migrations-and-drift": GitCompare,
  "/docs/concepts/the-safety-model": Shield,
  "/docs/concepts/tenant-isolation": Landmark,
  "/docs/operate/using-okmodel-safely": Lock,
  "/docs/operate/production-checklist": ClipboardCheck,
  "/docs/operate/testing": FlaskConical,
  "/docs/operate/protected-targets-and-roles": ShieldPlus,
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
  "/docs/operate/observers": Radio,
  "/docs/operate/opentelemetry": Activity,
  "/docs/schema/the-schema": Braces,
  "/docs/schema/codecs-and-row-types": Binary,
  "/docs/schema/extensions": Blocks,
  "/docs/schema/functions": SquareFunction,
  "/docs/schema/triggers": Zap,
  "/docs/schema/views": GalleryHorizontal,
  "/docs/schema/several-catalogs": Share2,
  "/docs/schema/tables": Table2,
  "/docs/schema/keys-and-identity": KeyRound,
  "/docs/schema/columns": Columns3,
  "/docs/schema/text-columns": ALargeSmall,
  "/docs/schema/number-columns": Calculator,
  "/docs/schema/time-columns": Clock,
  "/docs/schema/binary-json-id-columns": Boxes,
  "/docs/schema/postgres-specific-columns": DatabaseZap,
  "/docs/schema/defaults": CirclePlus,
  "/docs/schema/enums-arrays-picklists": Shapes,
  "/docs/schema/names-and-casing": CaseSensitive,
  "/docs/schema/visibility": Eye,
  "/docs/schema/validation": ShieldCheck,
  "/docs/schema/references": Link2,
  "/docs/schema/relations": Waypoints,
  "/docs/schema/indexes": ListTree,
  "/docs/schema/checks": SquareCheck,
  "/docs/queries/read-rows": BookOpen,
  "/docs/queries/request-filters": ListFilter,
  "/docs/schema/traits": Puzzle,
  "/docs/schema/tenancy": Building2,
  "/docs/queries/presets": Bookmark,
  "/docs/queries/search-and-trees": TextSearch,
  "/docs/queries/shape-results": ChartColumn,
  "/docs/schema/required-rows": Rows3,
  "/docs/queries": Search,
  "/docs/queries/typed-raw-sql": SquareCode,
  "/docs/queries/write-rows": PenLine,
  "/docs/reference/cli": SquareTerminal,
  "/docs/reference/compatibility": Scale,
  "/docs/reference/schema-api": Braces,
  "/docs/reference/github-action": GitPullRequest,
  "/docs/reference/errors": OctagonAlert,
  "/docs/reference/warnings": TriangleAlert,
  "/docs/migrations/type-change": Replace,
  "/docs/migrations/checks-and-lint": ListChecks,
  "/docs/migrations/backfill": Repeat,
  "/docs/migrations/failures": CircleX,
  "/docs/migrations/environments": Server,
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
