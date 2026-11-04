import { schema, table, t } from "okmodel/pg";

/** A short slug that redirects to a long URL. */
export const links = table("links", {
  id: t.identity(),
  slug: t.text().unique(),
  url: t.text(),
  createdAt: t.timestamptz().defaultSql("now()"),
});

/** One row per redirect. */
export const clicks = table("clicks", {
  id: t.identity(),
  linkId: t.bigint().references("links"),
  clickedAt: t.timestamptz().defaultSql("now()"),
});

export const app = schema({ casing: "snake", tables: [links, clicks] });
