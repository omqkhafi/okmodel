/**
 * Checked-in map from repository markdown to public handbook pages.
 * `site/scripts/sync-docs.ts` is the only writer of `site/content/docs/`.
 */

/** Sidebar group. `root` pages sit above the folders. */
export type DocGroupId = "root" | "start" | "model" | "ship" | "reference";

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

/** Sidebar folder. */
export interface DocGroup {
  readonly id: Exclude<DocGroupId, "root">;
  readonly title: string;
  /** Root-sidebar label, including the learning-path number. */
  readonly separator: string;
  readonly order: number;
}

/** Folder order in the sidebar. The number is the learning path, not a spec section. */
export const docGroups: readonly DocGroup[] = [
  { id: "start", title: "Start", separator: "01 Start", order: 10 },
  { id: "model", title: "Model", separator: "02 Model", order: 20 },
  { id: "ship", title: "Ship", separator: "03 Ship", order: 30 },
  { id: "reference", title: "Reference", separator: "04 Reference", order: 40 },
];

/**
 * Public pages. The learning path is authored under `site/handbook`.
 * Repository docs stay in Reference, with descriptions written for a reader.
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
    slug: "install",
    title: "Install",
    description: "Add the package and point the config at your schema.",
    group: "start",
    order: 0,
    source: "site/handbook/install.mdx",
    handbook: "handbook/install.mdx",
  },
  {
    slug: "query",
    title: "First query",
    description: "Define one table, apply it, and read the row back.",
    group: "start",
    order: 1,
    source: "site/handbook/query.mdx",
    handbook: "handbook/query.mdx",
  },
  {
    slug: "schema",
    title: "Schema",
    description: "Tables, keys, and relations. The schema is the catalog.",
    group: "model",
    order: 0,
    source: "site/handbook/schema.mdx",
    handbook: "handbook/schema.mdx",
  },
  {
    slug: "queries",
    title: "Queries",
    description: "Insert a row, then find it. The result follows the table.",
    group: "model",
    order: 1,
    source: "site/handbook/queries.mdx",
    handbook: "handbook/queries.mdx",
  },
  {
    slug: "safety",
    title: "Safety",
    description: "Hidden fields, guarded writes, and tenancy declared once.",
    group: "model",
    order: 2,
    source: "site/handbook/safety.mdx",
    handbook: "handbook/safety.mdx",
  },
  {
    slug: "migrations",
    title: "Migrations",
    description: "Generate SQL from the schema. The files lint and check themselves.",
    group: "ship",
    order: 0,
    source: "site/handbook/migrations.mdx",
    handbook: "handbook/migrations.mdx",
  },
  {
    slug: "drivers",
    title: "Drivers",
    description: "postgres.js, node-postgres, PGlite, and Bun.sql. Postgres 15 to 18.",
    group: "ship",
    order: 1,
    source: "site/handbook/drivers.mdx",
    handbook: "handbook/drivers.mdx",
  },
  {
    slug: "production",
    title: "Production",
    description: "Protect the production database, and require its catalog before connecting.",
    group: "reference",
    order: 0,
    source: "docs/production.md",
  },
  {
    slug: "environments",
    title: "Environments",
    description: "An environment is a named database target.",
    group: "reference",
    order: 1,
    source: "docs/environments.md",
  },
  {
    slug: "testing",
    title: "Testing",
    description: "Open a real database. There is no mock.",
    group: "reference",
    order: 2,
    source: "docs/testing.md",
  },
  {
    slug: "topology",
    title: "Topology",
    description: "One primary and any number of replicas, each with its own pool.",
    group: "reference",
    order: 3,
    source: "docs/topology.md",
  },
  {
    slug: "provisioning",
    title: "Provisioning",
    description: "Rows the application needs are declared on the table and inserted when missing.",
    group: "reference",
    order: 4,
    source: "docs/provisioning.md",
  },
  {
    slug: "check",
    title: "Check migrations",
    description: "Replay a migration history on a throwaway database and fail the pipeline if it is wrong.",
    group: "reference",
    order: 5,
    source: "docs/migrate-check.md",
  },
  {
    slug: "backfill",
    title: "Backfill",
    description: "A backfill is a step in a migration file. There is no separate backfill command.",
    group: "reference",
    order: 6,
    source: "docs/backfill.md",
  },
  {
    slug: "linter",
    title: "Linter",
    description: "The linter reads a migration plan. It does not connect to the database.",
    group: "reference",
    order: 7,
    source: "docs/linter.md",
  },
  {
    slug: "compatibility",
    title: "Driver compatibility",
    description: "What each driver does, from the conformance run.",
    group: "reference",
    order: 8,
    source: "docs/compatibility.md",
  },
  {
    slug: "size",
    title: "Size",
    description: "Measured size of the runtime and a small application.",
    group: "reference",
    order: 9,
    source: "docs/size.md",
  },
  {
    slug: "known-limits",
    title: "Known limits",
    description: "What this version does not do.",
    group: "reference",
    order: 10,
    source: "docs/known-limits.md",
  },
  {
    slug: "api",
    title: "API",
    description: "Which exports are stable, which are experimental, and which stay internal.",
    group: "reference",
    order: 11,
    source: "docs/api.md",
  },
  {
    slug: "specification",
    title: "Specification",
    description: "The contract for the catalog, queries, and migrations.",
    group: "reference",
    order: 12,
    source: "docs/okmodel-api-design.md",
  },
  {
    slug: "editor-check",
    title: "Editor check",
    description: "Hover, completions, and diagnostics for the editor.",
    group: "reference",
    order: 13,
    source: "docs/editor-check.md",
  },
  {
    slug: "example-app",
    title: "Example application",
    description: "A small project tracker that uses only the public entry points.",
    group: "reference",
    order: 14,
    source: "docs/example-app.md",
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
    reason: "Tested code corpus. Learning pages quote these fences. The file is not its own article.",
  },
  {
    path: "docs/quickstart.md",
    reason: "The tarball test script. The handbook Start pages are the public quickstart.",
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
  const ext = page.handbook?.endsWith(".mdx") === true ? "mdx" : "md";
  if (page.group === "root") return `${page.slug}.${ext}`;
  return `${page.group}/${page.slug}.${ext}`;
}
