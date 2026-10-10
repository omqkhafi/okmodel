/**
 * Checked-in map from repository markdown to public handbook pages.
 * `site/scripts/sync-docs.ts` is the only writer of `site/content/docs/`.
 */

/** Sidebar group. `root` pages sit above the folders. */
export type DocGroupId =
  | "root"
  | "guides"
  | "reference"
  | "run"
  | "migrations"
  | "tooling"
  | "limits";

/** One public page. */
export interface MappedPage {
  /** File slug inside the group. `index` is `/docs`. */
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
}

/** A `docs/` file that is not a handbook page, and why. */
export interface ExcludedDoc {
  readonly path: string;
  readonly reason: string;
}

/** Sidebar folder. */
export interface DocGroup {
  readonly id: Exclude<DocGroupId, "root">;
  readonly title: string;
  readonly order: number;
}

/** Folder order in the sidebar. */
export const docGroups: readonly DocGroup[] = [
  { id: "guides", title: "Guides", order: 10 },
  { id: "reference", title: "Reference", order: 20 },
  { id: "run", title: "Run", order: 30 },
  { id: "migrations", title: "Migrations", order: 40 },
  { id: "tooling", title: "Tooling", order: 50 },
  { id: "limits", title: "Limits", order: 60 },
];

/**
 * Public pages. Descriptions are the source's own first sentence.
 * Titles for repository docs are the source `h1`, except the design spec,
 * which is published as Specification.
 */
export const mappedPages: readonly MappedPage[] = [
  {
    slug: "index",
    title: "Introduction",
    description: "okmodel is a catalog-first TypeScript ORM, PostgreSQL first.",
    group: "root",
    order: 0,
    source: "README.md",
    readmeIntro: true,
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    description: "Set `DATABASE_URL` to a direct Postgres URL, not a pooler.",
    group: "root",
    order: 1,
    source: "docs/quickstart.md",
  },
  {
    slug: "install",
    title: "Install",
    description: "Four Postgres drivers.",
    group: "guides",
    order: 0,
    source: "README.md",
    readmeSection: "Install",
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    description: "This builds two tables, applies them, and runs one script.",
    group: "guides",
    order: 1,
    source: "README.md",
    readmeSection: "Quickstart",
  },
  {
    slug: "core",
    title: "Core",
    description: "The calls below use the same schema and the same client.",
    group: "guides",
    order: 2,
    source: "README.md",
    readmeSection: "Core",
  },
  {
    slug: "in-the-box",
    title: "What is in the box",
    description: "Each section below is one feature you can add to the schema above.",
    group: "guides",
    order: 3,
    source: "README.md",
    readmeSection: "What is in the box",
  },
  {
    slug: "commands",
    title: "Commands",
    description: "`okmodel` and `okm` are the same command.",
    group: "guides",
    order: 4,
    source: "README.md",
    readmeSection: "Commands",
  },
  {
    slug: "check",
    title: "Check a history in CI",
    description: "`okm migrate check` is the command for a pipeline.",
    group: "guides",
    order: 5,
    source: "README.md",
    readmeSection: "Check a history in CI",
  },
  {
    slug: "roadmap",
    title: "Roadmap",
    description: "Each release is a milestone.",
    group: "guides",
    order: 6,
    source: "README.md",
    readmeSection: "Roadmap",
  },
  {
    slug: "api",
    title: "API",
    description:
      "0.1 classifies every export as **stable**, **experimental**, or **internal**.",
    group: "reference",
    order: 0,
    source: "docs/api.md",
  },
  {
    slug: "specification",
    title: "Specification",
    description: "Status: design draft, 2026-09-30. Not yet approved for implementation.",
    group: "reference",
    order: 1,
    source: "docs/okmodel-api-design.md",
  },
  {
    slug: "production",
    title: "Production",
    description:
      "Nothing about an environment is inferred from `NODE_ENV` or from a target's name (spec §19.8).",
    group: "run",
    order: 0,
    source: "docs/production.md",
  },
  {
    slug: "environments",
    title: "Environments",
    description: "An environment is a named target.",
    group: "run",
    order: 1,
    source: "docs/environments.md",
  },
  {
    slug: "testing",
    title: "Testing",
    description:
      "`okmodel/testing` opens a real database and returns factories, a query counter, and a cross-tenant isolation check.",
    group: "run",
    order: 2,
    source: "docs/testing.md",
  },
  {
    slug: "topology",
    title: "Topology",
    description: "`connect({ primary, replicas }, options)` opens one pool per endpoint.",
    group: "run",
    order: 3,
    source: "docs/topology.md",
  },
  {
    slug: "provisioning",
    title: "Provisioning",
    description: "An empty target installs the head snapshot.",
    group: "run",
    order: 4,
    source: "docs/provisioning.md",
  },
  {
    slug: "check",
    title: "Check a history in CI",
    description: "`okm migrate check` proves a migration history is sound.",
    group: "migrations",
    order: 0,
    source: "docs/migrate-check.md",
  },
  {
    slug: "backfill",
    title: "Backfill",
    description: "A backfill is a step in a migration file (D59, D195).",
    group: "migrations",
    order: 1,
    source: "docs/backfill.md",
  },
  {
    slug: "linter",
    title: "Linter",
    description: "The linter reads a migration plan and the catalogs before and after it.",
    group: "migrations",
    order: 2,
    source: "docs/linter.md",
  },
  {
    slug: "compatibility",
    title: "Driver compatibility",
    description:
      "Generated from the conformance run (`tests/driver-suite.test.ts` and `tests/error-suite.test.ts`).",
    group: "tooling",
    order: 0,
    source: "docs/compatibility.md",
  },
  {
    slug: "editor-check",
    title: "Editor check",
    description: "`bun run editor-check` drives the TypeScript 6 language server over stdio.",
    group: "tooling",
    order: 1,
    source: "docs/editor-check.md",
  },
  {
    slug: "example-app",
    title: "Example application",
    description:
      "`packages/reference-app` is a small project tracker that uses OKModel only through its public entry points.",
    group: "tooling",
    order: 2,
    source: "docs/example-app.md",
  },
  {
    slug: "known-limits",
    title: "Known limits",
    description: "What this version does not do, or does differently from what you might expect.",
    group: "limits",
    order: 0,
    source: "docs/known-limits.md",
  },
  {
    slug: "size",
    title: "Size and cold start",
    description: "The table in this section is the 0.5.0 release sample.",
    group: "limits",
    order: 1,
    source: "docs/size.md",
  },
];

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
    reason:
      "Tested code corpus. Guide pages splice these fences in; the file is not its own article.",
  },
];

/**
 * Public URL for one mapped page.
 *
 * @param page - Mapped page
 */
export function pageHref(page: MappedPage): string {
  if (page.group === "root") {
    return page.slug === "index" ? "/docs" : `/docs/${page.slug}`;
  }
  return `/docs/${page.group}/${page.slug}`;
}

/**
 * Path of the generated markdown file, relative to `content/docs`.
 *
 * @param page - Mapped page
 */
export function pageContentPath(page: MappedPage): string {
  if (page.group === "root") return `${page.slug}.md`;
  return `${page.group}/${page.slug}.md`;
}
