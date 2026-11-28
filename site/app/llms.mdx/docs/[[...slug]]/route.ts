import { markdownResponse } from "@/lib/markdown-response";
import { markdownPathForSlugs } from "@/lib/markdown-url";
import { markdownNotFoundResponse } from "@/lib/not-found-markdown";
import { getPageSourceMarkdown } from "@/lib/page-markdown";
import { getPageMarkdownUrl, resolveMarkdownPage, source } from "@/lib/source";

export const revalidate = false;

/**
 * Only twins listed in `generateStaticParams` are served. Unknown paths 404
 * at the routing layer; the proxy answers markdown `Accept` for missing
 * handbook pages before a rewrite lands here.
 */
export const dynamicParams = false;

/**
 * Serve the page markdown (YAML frontmatter stripped). A heading attribute
 * `[feature="key"]` is replaced by the plain support line.
 * Canonical: `/llms.mdx/docs/⟨slug⟩.md`. Also accepts `/content.md`
 * and the extensionless slug. Rewrite target for `Accept: text/markdown`
 * on `/docs/⟨slug⟩`, so the response carries `Vary: Accept`.
 */
export async function GET(_req: Request, { params }: RouteContext<"/llms.mdx/docs/[[...slug]]">) {
  const { slug } = await params;
  const page = resolveMarkdownPage(slug);
  if (!page) return markdownNotFoundResponse();

  const markdown = await getPageSourceMarkdown(page);
  const twin = markdownPathForSlugs(page.slugs);
  const response = markdownResponse(markdown);
  response.headers.append("Link", `<${twin}>; rel="alternate"; type="text/markdown"`);
  return response;
}

export function generateStaticParams() {
  return source.getPages().flatMap((page) => {
    const canonical = { slug: getPageMarkdownUrl(page).segments };
    const legacy =
      page.slugs.length > 0 ? { slug: [...page.slugs, "content.md"] } : { slug: ["content.md"] };
    return [canonical, legacy];
  });
}
