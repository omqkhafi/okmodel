/**
 * Permanent redirects for handbook URLs shipped in 0.10.0 (README, error
 * bodies, and package docs). Kept minimal; only `site/next.config.ts` mounts
 * this list. `permanent: true` is HTTP 308.
 */

/** One Next.js redirect entry. */
export type DocsRedirect = {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
};

/**
 * Specific retired paths first, then the `/docs/define` catch-all.
 * Order matters: Next applies the first match.
 */
export const DOCS_REDIRECTS: readonly DocsRedirect[] = [
  {
    source: "/docs/define/table/validation",
    destination: "/docs/schema/validation",
    permanent: true,
  },
  {
    source: "/docs/define/schema/tenancy",
    destination: "/docs/schema/tenancy",
    permanent: true,
  },
  {
    source: "/docs/define/table/queries",
    destination: "/docs/queries/search-and-trees",
    permanent: true,
  },
  {
    source: "/docs/define/table/presets",
    destination: "/docs/queries/presets",
    permanent: true,
  },
  {
    source: "/docs/define/table/traits",
    destination: "/docs/schema/traits",
    permanent: true,
  },
  {
    source: "/docs/start/basic-usage",
    destination: "/docs/start/first-schema",
    permanent: true,
  },
  {
    source: "/docs/start/from-drizzle",
    destination: "/docs/migrations/from-drizzle",
    permanent: true,
  },
  {
    source: "/docs/define/:path*",
    destination: "/docs",
    permanent: true,
  },
];
