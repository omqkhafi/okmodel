import { remarkFeatureMarks } from "./lib/feature-heading";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

/**
 * Support fields. Optional here so pages on the exemption list still build.
 * `scripts/docs-frontmatter.ts` requires them for every other page.
 */
const handbookPageSchema = pageSchema.extend({
  summary: z.string().optional(),
  since: z.string().optional(),
  feature: z.string().optional(),
  status: z.enum(["stable", "experimental", "deprecated"]).optional(),
});

/**
 * Docs collection. `content/docs` is the handbook: pages, frontmatter, and
 * `meta.json` sidebar order are written there by hand.
 */
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: handbookPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkFeatureMarks, ...plugins],
  },
});
