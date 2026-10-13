/**
 * Checked-in map from repository markdown to public handbook pages.
 * `site/scripts/sync-docs.ts` is the only writer of `site/content/docs/`.
 */

/** Sidebar group. `root` pages sit above the folders. */
export type DocGroupId = "root" | "start" | "config" | "schema" | "table";

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
 * Start stays one flat folder. Define holds Config, Schema, and Table.
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
  { id: "config", title: "Config", order: 0 },
  { id: "schema", title: "Schema", order: 1 },
  { id: "table", title: "Table", order: 2 },
];

/** Sections whose folders stay collapsed in the sidebar. */
export const docSections: readonly DocSection[] = [
  {
    id: "define",
    separator: "02 Define",
    order: 20,
    groups: ["config", "schema", "table"],
  },
];

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
    slug: "query",
    title: "Let's start",
    description: "Install a driver, define the table, then build, generate, and apply.",
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
  ...definePages(),
];

/**
 * Authored pages under Config, Schema, and Table.
 *
 * The path is `site/handbook/<group>/<slug>.mdx`.
 */
function definePages(): readonly MappedPage[] {
  const page = (
    group: "config" | "schema" | "table",
    order: number,
    slug: string,
    title: string,
    description: string,
  ): MappedPage => ({
    slug,
    title,
    description,
    group,
    order,
    source: `site/handbook/${group}/${slug}.mdx`,
    handbook: `handbook/${group}/${slug}.mdx`,
  });
  return [
    page("config", 0, "file", "Overview", "defineConfig in okmodel.config.ts. schema is required. Set database or targets."),
    page("config", 1, "targets", "Targets", "Any key is a name. Protection is the protected flag, not the target name."),
    page("config", 2, "paths", "Paths", "schema, tables, migrations, and out. Each path resolves from the project directory."),
    page("config", 3, "pooler", "Pooler", "Migration commands refuse a pooler host unless allowPooler is set."),
    page("config", 4, "timeouts", "Timeouts", "lock defaults to 5000. statement defaults to 30000. A flag overrides the config."),
    page("config", 5, "lint", "Lint baseline", "lintFrom is the first migration id check lints. Apply does not read it. Files before it are the adoption baseline."),
    page("config", 6, "backfill", "Backfill", "batchSize is written into a new plan. pauseMs and statementTimeoutMs apply when the batches run. A step header overrides the batch."),
    page("config", 7, "roles", "Roles", "migration runs the files. app receives the grants. reporting is select only. managed roles are created and never dropped."),
    page("schema", 0, "tables", "Tables", "schema() compiles the tables array into one catalog. table() only stores the columns."),
    page("schema", 1, "casing", "Casing", "casing: snake writes field names as snake_case SQL names."),
    page("schema", 2, "codecs", "Codecs", "bigint, numeric, and timestamps choose how a value is typed in TypeScript."),
    page("schema", 3, "types", "Row types", "types is emitted or inferred. Emitted is the default."),
    page("schema", 4, "defaults", "Id default", "defaults.id is what a bare t.id() means. A column option wins."),
    page("schema", 5, "requires", "Postgres version", "requires.postgres is the engine connect records."),
    page("schema", 6, "traits", "Traits", "traits apply to every table. A table opts out with omitDefaults and a reason."),
    page("schema", 7, "tenancy", "Tenancy", "columnTenancy adds one key to every table. global(reason) opts a table out."),
    page("schema", 8, "validation", "Validation", "validation turns rules on for the schema. A table can turn them off."),
    page("schema", 9, "extensions", "Extensions", "extension() declares a Postgres extension. version pins it. schema is where it installs."),
    page("schema", 10, "functions", "Functions", "fn() declares a function. plpgsql needs dependsOn. security definer needs searchPath."),
    page("schema", 11, "triggers", "Triggers", "trigger() names the table, the timing, the events, and the function it calls."),
    page("schema", 12, "views", "Views", "view() and materializedView() declare a query and its output columns."),
    page("table", 0, "columns", "Columns", "table() takes a name and a column map. t is every builder."),
    page("table", 1, "keys", "Keys", "One primary key, on the column or as a list. unique names a constraint."),
    page("table", 2, "indexes", "Indexes", "indexes returns index calls. unique() marks one unique."),
    page("table", 3, "checks", "Checks", "A check is named SQL. sql interpolates a column handle as its SQL name."),
    page("table", 4, "defaults", "Defaults", "nullable allows NULL. default stores a literal or a client generator. generated omits the column from writes."),
    page("table", 5, "references", "References", "references() points a column at another table. schema() checks that the table exists."),
    page("table", 6, "relations", "Relations", "one and many name a table. manyThrough names the join table."),
    page("table", 7, "visibility", "Visibility", "hidden leaves a column out of the default row. sensitive redacts logs. guarded omits the column from writes."),
    page("table", 8, "names", "Names", "sqlName is the catalog name. renamedFrom is the previous name. comment is stored beside the object."),
    page("table", 9, "traits", "Table traits", "traits on a table are added with the schema defaults. omitDefaults skips the defaults."),
    page("table", 10, "tenancy", "Table tenancy", "global(reason) keeps the tenant key off this table. via isolates through a relation."),
    page("table", 11, "presets", "Presets", "A preset is a named refinement. It can only add a predicate."),
    page("table", 12, "reference", "Reference rows", "reference rows are inserted when the key is missing. Apply does not update or delete them."),
    page("table", 13, "filters", "Filters", "filters() allowlists the operators a caller may send. A hidden field in allow throws."),
    page("table", 14, "validation", "Column validation", "validate stores rules. The same field on the column and the table is OKM1030."),
    page("table", 15, "shape", "Arrays and picklists", "array() wraps a scalar. picklist() narrows a string column to a literal union."),
  ];
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
    path: "docs/size.md",
    reason: "Removed from the public handbook.",
  },
  {
    path: "docs/known-limits.md",
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
