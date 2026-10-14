/**
 * Homepage hero copy. One place, so the HTML hero and its markdown twin say the
 * same thing. Every claim here is one the hero stage shows or the README makes.
 */

/** The two lines of the headline. Joined, they are the page's `h1`. */
export const HERO_HEADLINE_LINES = ["Edit your schema.", "Get a safe migration."] as const;

/** Positioning pill above the headline. */
export const HERO_PILL = "A catalog-first ORM for PostgreSQL";

/** One-paragraph pitch under the headline. */
export const HERO_SUBHEAD =
  "Every change to schema.ts becomes a lock-aware migration, a lint report, and fresh types. Typed in TypeScript, with no runtime dependencies.";
