/**
 * Checked-in map from repository markdown to public handbook pages.
 * `site/scripts/sync-docs.ts` is the only writer of `site/content/docs/`.
 */

/** Sidebar group. `root` pages sit above the folders. */
export type DocGroupId = "root" | "start" | "define";

/** One public page. */
export interface MappedPage {
  /** File slug inside the group. `index` is the folder URL: `/docs`, or `/docs/<group>`. */
  readonly slug: string;
  readonly title: string;
  /** First sentence of the source, kept here so the sidebar text is reviewed. */
  readonly description: string;
  readonly group: DocGroupId;
  /** Order inside the group. Lower comes first. */
  readonly order: number;
  /** Repo-relative file Edit on GitHub opens. */
  readonly source: string;
  /**
   * README `##` heading to extract. Absent for a whole file.
   * The introduction uses the preamble before the first `##`.
   */
  readonly readmeSection?: string;
  /** True for the README preamble (title and positioning), not an `##` section. */
  readonly readmeIntro?: boolean;
  /**
   * Site-relative authored page (`site/handbook/...`). The public handbook
   * is written here. README sections are not handbook pages.
   */
  readonly handbook?: string;
}

/** A `docs/` file that is not a handbook page, and why. */
export interface ExcludedDoc {
  readonly path: string;
  readonly reason: string;
}

/** Sidebar folder. A separator is the numbered label above a flat folder. */
export interface DocGroup {
  readonly id: Exclude<DocGroupId, "root">;
  readonly title: string;
  /**
   * Root-sidebar label, including the learning-path number.
   *
   * Absent when the folder sits inside a {@link DocSection}.
   */
  readonly separator?: string;
  readonly order: number;
}

/**
 * Numbered label that holds several folders.
 *
 * Start and Define are both unwrapped in the sidebar, so their pages are rows.
 */
export interface DocSection {
  readonly id: string;
  readonly separator: string;
  readonly order: number;
  readonly groups: readonly Exclude<DocGroupId, "root">[];
}

/** Folder order in the sidebar. The number is the learning path, not a spec section. */
export const docGroups: readonly DocGroup[] = [
  { id: "start", title: "Start", separator: "01 Start", order: 10 },
  { id: "define", title: "Define", separator: "02 Define", order: 20 },
];

/**
 * Nested folders under a numbered label.
 *
 * Empty: Start and Define are flat groups, unwrapped by the sidebar.
 */
export const docSections: readonly DocSection[] = [];

/**
 * Public pages. The learning path is authored under `site/handbook`.
 */
export const mappedPages: readonly MappedPage[] = [
  {
    slug: "index",
    title: "Documentation",
    description: "okmodel is a catalog-first TypeScript ORM, PostgreSQL first.",
    group: "root",
    order: 0,
    source: "site/handbook/index.mdx",
    handbook: "handbook/index.mdx",
  },
  {
    slug: "index",
    title: "Let's start",
    description: "Install a driver, define the table, then push and connect.",
    group: "start",
    order: 0,
    source: "site/handbook/query.mdx",
    handbook: "handbook/query.mdx",
  },
  {
    slug: "basic-usage",
    title: "Basic Usage",
    description: "Each call on the client: insert, find, one, count, exists, update, and delete.",
    group: "start",
    order: 1,
    source: "site/handbook/basic-usage.mdx",
    handbook: "handbook/basic-usage.mdx",
  },
  {
    slug: "queries",
    title: "Queries",
    description: "Insert a row, then find it. The result follows the table.",
    group: "start",
    order: 2,
    source: "site/handbook/queries.mdx",
    handbook: "handbook/queries.mdx",
  },
  definePage(0, "table", "Table", "table() stores the columns. The key comes first, then each data type, then the options."),
  definePage(1, "schema", "Schema", "schema() compiles the tables into one catalog. Each section is one option."),
  definePage(2, "connect", "Connect", "connect() opens the client. The first argument is the target. schema is required."),
  definePage(3, "config", "Config", "defineConfig is the file okm reads. Each section is one option."),
];

/**
 * One page under Define. The public URL is `/docs/define/<slug>`.
 *
 * @param order - Order inside Define
 * @param slug - File slug and URL segment
 * @param title - Sidebar and page title
 * @param description - Sentence under the title
 */
function definePage(order: number, slug: string, title: string, description: string): MappedPage {
  return {
    slug,
    title,
    description,
    group: "define",
    order,
    source: `site/handbook/define/${slug}.mdx`,
    handbook: `handbook/define/${slug}.mdx`,
  };
}

/**
 * `docs/` files that stay in the repository and are not handbook pages.
 * A file under `docs/` must be mapped or listed here.
 */
export const excludedDocs: readonly ExcludedDoc[] = [
  {
    path: "docs/okmodel-decisions.md",
    reason: "Decision log. Linked from the repository, not published as a handbook page.",
  },
  {
    path: "docs/okmodel-execution-plan.md",
    reason: "Execution plan. Linked from the repository, not published as a handbook page.",
  },
  {
    path: "docs/okmodel-gap-research.md",
    reason: "Gap research notes. Not a handbook page.",
  },
  {
    path: "docs/m0-findings.md",
    reason: "M0 evidence. Not a handbook page.",
  },
  {
    path: "docs/github.md",
    reason: "Repository process for issues and pull requests. Not a handbook page.",
  },
  {
    path: "docs/release.md",
    reason: "How a release is published. Not a handbook page.",
  },
  {
    path: "docs/readme-examples.md",
    reason: "Tested code corpus. Learning pages quote these fences. The file is not its own article.",
  },
  {
    path: "docs/quickstart.md",
    reason: "The tarball test script. The handbook Start pages are the public quickstart.",
  },
  {
    path: "docs/production.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/environments.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/testing.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/topology.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/provisioning.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/migrate-check.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/backfill.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/linter.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/compatibility.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/known-limits.md",
    reason: "Removed from the public handbook. The file stays in the repository.",
  },
  {
    path: "docs/size.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/api.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/okmodel-api-design.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/editor-check.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/example-app.md",
    reason: "Removed from the public handbook.",
  },
];

/**
 * Public URL for one mapped page.
 *
 * @param page - Mapped page
 */
export function pageHref(page: MappedPage): string {
  const segments: string[] = page.group === "root" ? [] : [page.group];
  if (page.slug !== "index") segments.push(page.slug);
  return segments.length === 0 ? "/docs" : `/docs/${segments.join("/")}`;
}

/**
 * Path of the generated markdown file, relative to `content/docs`.
 *
 * @param page - Mapped page
 */
export function pageContentPath(page: MappedPage): string {
  const ext = page.handbook?.endsWith(".mdx") === true ? "mdx" : "md";
  if (page.group === "root") return `${page.slug}.${ext}`;
  return `${page.group}/${page.slug}.${ext}`;
}
