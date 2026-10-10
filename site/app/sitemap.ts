import { SITE_ORIGIN } from "@/lib/site-identity";
import { changelogSeriesPath, loadChangelogSeries } from "@/lib/changelog";
import { source } from "@/lib/source";
import type { MetadataRoute } from "next";

export const revalidate = false;

/**
 * HTML handbook pages plus the machine-readable entry points.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${SITE_ORIGIN}${page.url}`,
    changeFrequency: "weekly",
    priority: page.url === "/docs" ? 0.9 : 0.7,
  }));

  return [
    { url: SITE_ORIGIN, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_ORIGIN}/changelog`, changeFrequency: "weekly", priority: 0.6 },
    ...loadChangelogSeries().map((entry) => ({
      url: `${SITE_ORIGIN}${changelogSeriesPath(entry.slug)}`,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
    { url: `${SITE_ORIGIN}/llms.txt`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_ORIGIN}/llms.json`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_ORIGIN}/llms-full.txt`, changeFrequency: "weekly", priority: 0.5 },
    ...pages,
  ];
}
